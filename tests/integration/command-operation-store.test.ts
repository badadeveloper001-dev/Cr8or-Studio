import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Never use DATABASE_URL, production credentials, dotenv, or arbitrary hosts.
function isolatedDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (!["postgresql:", "postgres:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.port !== "55432" || url.pathname !== "/cr8or_auth_test") {
    throw new Error("Command store tests require the isolated local test database on port 55432.");
  }
  return url;
}
const configuredUrl = process.env.CR8OR_AUTH_TEST_DATABASE_URL;
const testUrl = configuredUrl ? isolatedDatabaseUrl(configuredUrl) : undefined;
const schemaName = `command_operation_${randomBytes(8).toString("hex")}`;
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousDirectUrl = process.env.DIRECT_URL;
const previousGlobal = globalThis.prismaGlobal;

describe.skipIf(!testUrl)("command coordination on isolated PostgreSQL", () => {
  let admin: PrismaClient;
  let database: PrismaClient;
  let independent: PrismaClient;
  let store: typeof import("@/lib/security/command-operation-store");
  let otherStore: typeof store;
  let legacySnapshot: unknown;

  const input = (workspaceId = "registered-daytona-workspace") => ({
    id: randomUUID(), projectId: "existing-project", workspaceId,
    commandKey: "npm run test:unit", actorId: "frontend", executionId: randomUUID(),
  });

  async function applyMigration(directory: string) {
    const sql = await readFile(path.join(process.cwd(), "prisma/migrations", directory, "migration.sql"), "utf8");
    const statements = sql.replace(/^\s*--.*$/gm, "").split(";").map((statement) => statement.trim())
      .filter((statement) => statement && !/^(BEGIN|COMMIT)$/i.test(statement));
    await database.$transaction(async (transaction) => {
      for (const statement of statements) await transaction.$executeRawUnsafe(statement);
    });
  }

  const snapshotLegacy = () => database.project.findUniqueOrThrow({
    where: { id: "existing-project" }, include: { workspaces: true, tasks: true, globals: true, locals: true },
  });

  beforeAll(async () => {
    const url = new URL(testUrl!);
    url.search = "";
    admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    url.searchParams.set("schema", schemaName);
    url.searchParams.set("connection_limit", "3");
    process.env.DATABASE_URL = url.toString();
    process.env.DIRECT_URL = url.toString();
    delete globalThis.prismaGlobal;
    vi.resetModules();
    database = (await import("@/lib/db/prisma")).prisma;
    store = await import("@/lib/security/command-operation-store");
    for (const migration of ["0_init", "20250101000000_add_workspace_table", "20261015000000_authentication_foundation"]) {
      await applyMigration(migration);
    }
    await database.project.create({ data: {
      id: "existing-project", name: "Historical fixture", description: "Synthetic test project", framework: "nextjs", language: "typescript",
      repository: "https://github.com/example/historical-fixture", workspaces: { create: {
        id: "existing-workspace", runtimeType: "cloud", provider: "daytona", providerWorkspaceId: "registered-daytona-workspace",
        repositoryUrl: "https://github.com/example/historical-fixture", branch: "main", state: "running",
      } }, tasks: { create: { agentId: "frontend", title: "Keep task", status: "done", output: "Synthetic history" } },
      globals: { create: { key: "fixture", value: "Synthetic memory" } },
      locals: { create: { agentId: "frontend", note: "Synthetic local memory" } },
    } });
    legacySnapshot = await snapshotLegacy();
    await applyMigration("20261016000000_command_operations");

    // Two independent Prisma pools and independently imported stores simulate
    // separate application instances. The database provides coordination.
    delete globalThis.prismaGlobal;
    vi.resetModules();
    independent = (await import("@/lib/db/prisma")).prisma;
    otherStore = await import("@/lib/security/command-operation-store");
    expect(independent).not.toBe(database);
    globalThis.prismaGlobal = database;
  }, 30_000);

  beforeEach(async () => { await database.$executeRaw`DELETE FROM "CommandOperation"`; });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    try {
      await database?.$disconnect();
      await independent?.$disconnect();
      if (admin) await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await admin?.$disconnect();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousDirectUrl === undefined) delete process.env.DIRECT_URL;
      else process.env.DIRECT_URL = previousDirectUrl;
      if (previousGlobal === undefined) delete globalThis.prismaGlobal;
      else globalThis.prismaGlobal = previousGlobal;
    }
  });

  it("adds coordination without changing historical projects, workspace identifiers, tasks, or memories", async () => {
    expect(await snapshotLegacy()).toEqual(legacySnapshot);
    expect(await database.ownerCredential.count()).toBe(0);
  });

  it("stores only bounded lifecycle metadata and uses the database clock", async () => {
    const request = input();
    vi.spyOn(Date, "now").mockReturnValue(0);
    await store.reserveCommandOperation(request);
    const record = await store.readCommandOperation(request.id);
    expect(record).toMatchObject({ ...request, status: "RESERVED", startedAt: null, completedAt: null, exitCode: null });
    const [clock] = await database.$queryRaw<Array<{ now: Date }>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"`;
    expect(Math.abs(record!.createdAt.getTime() - clock.now.getTime())).toBeLessThan(5_000);
    expect(Object.keys(record!).sort()).toEqual([
      "id", "projectId", "workspaceId", "commandKey", "actorId", "executionId", "status", "createdAt", "startedAt",
      "completedAt", "updatedAt", "exitCode", "cancellationConfirmed", "cleanupConfirmed",
    ].sort());
  });

  it("atomically permits only one reservation across independent application instances", async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? otherStore : store).reserveCommandOperation(input())));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 409 });
    expect(await database.$queryRaw`SELECT "status" FROM "CommandOperation"`).toEqual([{ status: "RESERVED" }]);
  });

  it("allows independent workspace reservations without a process-global limit", async () => {
    await expect(Promise.all([
      store.reserveCommandOperation(input("sandbox-a")), otherStore.reserveCommandOperation(input("sandbox-b")),
    ])).resolves.toEqual([undefined, undefined]);
  });

  it("claims each dispatch once and rejects retry after a lost acknowledgement", async () => {
    const request = input();
    await store.reserveCommandOperation(request);
    const claims = await Promise.allSettled([store.markCommandDispatched(request.id), otherStore.markCommandDispatched(request.id)]);
    expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(claims.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(await store.readCommandOperation(request.id)).toMatchObject({ status: "RUNNING", startedAt: expect.any(Date) });
  });

  it("rejects duplicate operation identifiers even after completion and on a different workspace", async () => {
    const request = input();
    await store.reserveCommandOperation(request);
    await store.finishCommandOperation(request.id, { status: "CANCELLED" });
    await expect(otherStore.reserveCommandOperation({ ...request, workspaceId: "sandbox-b" })).rejects.toMatchObject({ status: 409 });
  });

  it("counts all reservations across instances and resets the rolling window using database time", async () => {
    for (let index = 0; index < 6; index++) {
      const request = input();
      const instance = index % 2 ? otherStore : store;
      await instance.reserveCommandOperation(request);
      await instance.finishCommandOperation(request.id, { status: "FAILED" });
    }
    await expect(otherStore.reserveCommandOperation(input())).rejects.toMatchObject({ status: 409 });
    await database.$executeRaw`
      UPDATE "CommandOperation" SET "createdAt" = (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '6 minutes'
    `;
    await expect(otherStore.reserveCommandOperation(input())).resolves.toBeUndefined();
  });

  it.each(["RESERVED", "RUNNING", "UNKNOWN"] as const)("never expires an unresolved %s operation", async (status) => {
    const request = input();
    await store.reserveCommandOperation(request);
    if (status !== "RESERVED") await store.markCommandDispatched(request.id);
    if (status === "UNKNOWN") await store.finishCommandOperation(request.id, { status: "UNKNOWN", cleanupConfirmed: true });
    await database.$executeRaw`
      UPDATE "CommandOperation" SET "createdAt" = TIMESTAMP '2000-01-01',
        "completedAt" = CASE WHEN "completedAt" IS NULL THEN NULL ELSE TIMESTAMP '2000-01-02' END
    `;
    expect(await store.cleanupCompletedCommandOperations()).toBe(0);
    await expect(otherStore.reserveCommandOperation(input())).rejects.toMatchObject({ status: 409 });
  });

  it("cannot clear an UNKNOWN outcome with a later ordinary lifecycle update", async () => {
    const request = input();
    await store.reserveCommandOperation(request);
    await store.markCommandDispatched(request.id);
    await store.finishCommandOperation(request.id, { status: "UNKNOWN" });
    await expect(store.finishCommandOperation(request.id, { status: "SUCCEEDED", exitCode: 0 })).rejects.toMatchObject({ status: 409 });
    await expect(store.markCommandDispatched(request.id)).rejects.toMatchObject({ status: 409 });
  });

  it.each(["CANCELLED", "TIMED_OUT", "FAILED"] as const)("requires positive remote termination evidence before releasing %s", async (status) => {
    const request = input();
    await store.reserveCommandOperation(request);
    await store.markCommandDispatched(request.id);
    await expect(store.finishCommandOperation(request.id, { status, cleanupConfirmed: true })).rejects.toMatchObject({ status: 409 });
    await expect(otherStore.reserveCommandOperation(input())).rejects.toMatchObject({ status: 409 });
    await store.finishCommandOperation(request.id, { status, cancellationConfirmed: true, cleanupConfirmed: true });
    await expect(otherStore.reserveCommandOperation(input())).resolves.toBeUndefined();
  });

  it.each([
    { status: "SUCCEEDED", exitCode: 0, cancellationConfirmed: true, cleanupConfirmed: true },
    { status: "FAILED", exitCode: 23, cancellationConfirmed: true, cleanupConfirmed: true },
  ] as const)("persists confirmed $status completion idempotently", async (completion) => {
    const request = input();
    await store.reserveCommandOperation(request);
    await store.markCommandDispatched(request.id);
    await store.finishCommandOperation(request.id, completion);
    const original = await store.readCommandOperation(request.id);
    expect(original).toMatchObject({ ...completion, completedAt: expect.any(Date), startedAt: expect.any(Date) });
    await otherStore.finishCommandOperation(request.id, completion);
    expect(await store.readCommandOperation(request.id)).toEqual(original);
    await expect(store.finishCommandOperation(request.id, { status: "CANCELLED" })).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    { status: "SUCCEEDED", exitCode: 0 },
    { status: "FAILED", exitCode: 23 },
  ] as const)("does not release dispatched $status work without both termination and cleanup confirmation", async (completion) => {
    const request = input();
    await store.reserveCommandOperation(request);
    await store.markCommandDispatched(request.id);
    for (const flags of [{}, { cancellationConfirmed: true }, { cleanupConfirmed: true }]) {
      await expect(store.finishCommandOperation(request.id, { ...completion, ...flags })).rejects.toMatchObject({ status: 409 });
    }
    await expect(otherStore.reserveCommandOperation(input())).rejects.toMatchObject({ status: 409 });
    expect(await store.readCommandOperation(request.id)).toMatchObject({ status: "RUNNING" });
  });

  it("rejects successful completion without a dispatch or with a nonzero exit", async () => {
    const request = input();
    await store.reserveCommandOperation(request);
    await expect(store.finishCommandOperation(request.id, { status: "SUCCEEDED", exitCode: 0 })).rejects.toMatchObject({ status: 409 });
    await store.markCommandDispatched(request.id);
    await expect(store.finishCommandOperation(request.id, { status: "SUCCEEDED", exitCode: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it("cleans only old confirmed terminal records, preserving the active rate window", async () => {
    const old = input("old-workspace");
    const recent = input("recent-workspace");
    for (const request of [old, recent]) {
      await store.reserveCommandOperation(request);
      await store.finishCommandOperation(request.id, { status: "CANCELLED" });
    }
    await database.$executeRaw`
      UPDATE "CommandOperation" SET "createdAt" = TIMESTAMP '2000-01-01', "completedAt" = TIMESTAMP '2000-01-02'
      WHERE "id" = ${old.id}::uuid
    `;
    expect(await store.cleanupCompletedCommandOperations()).toBe(1);
    expect(await store.readCommandOperation(old.id)).toBeNull();
    expect(await store.readCommandOperation(recent.id)).not.toBeNull();
  });

  it("enforces the one-unresolved-workspace invariant and catalogue in PostgreSQL itself", async () => {
    const request = input();
    await store.reserveCommandOperation(request);
    await expect(database.$executeRaw`
      INSERT INTO "CommandOperation" ("id", "projectId", "workspaceId", "commandKey", "actorId", "executionId", "updatedAt")
      VALUES (${randomUUID()}::uuid, 'existing-project', ${request.workspaceId}, 'npm test', 'frontend', ${randomUUID()}::uuid, NOW())
    `).rejects.toThrow();
    await expect(database.$executeRaw`
      INSERT INTO "CommandOperation" ("id", "projectId", "workspaceId", "commandKey", "actorId", "executionId", "updatedAt")
      VALUES (${randomUUID()}::uuid, 'existing-project', 'another-workspace', 'npm test; rm -rf /', 'frontend', ${randomUUID()}::uuid, NOW())
    `).rejects.toThrow();
    const [table] = await database.$queryRaw<Array<{ enabled: boolean; policies: bigint }>>`
      SELECT c.relrowsecurity AS enabled,
        (SELECT COUNT(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'CommandOperation' AND n.nspname = ${schemaName}
    `;
    expect(table).toEqual({ enabled: true, policies: BigInt(0) });
  });

  it.each([
    { id: "not-a-uuid" }, { executionId: "forged-context" }, { projectId: "" }, { workspaceId: "x".repeat(257) },
    { commandKey: "npm test && echo secret" }, { actorId: "arbitrary client role" },
  ])("rejects malformed metadata before persistence: %j", async (change) => {
    await expect(store.reserveCommandOperation({ ...input(), ...change })).rejects.toMatchObject({ status: 409 });
    expect(await database.$queryRaw`SELECT "id" FROM "CommandOperation"`).toEqual([]);
  });

  it("fails closed with sanitized database errors and no provider/credential details", async () => {
    const error = new Error("postgresql://synthetic-secret:password@private-host sensitive query arguments");
    vi.spyOn(database, "$transaction").mockRejectedValueOnce(error);
    const failure = await store.reserveCommandOperation(input()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 503, message: "Command coordination is unavailable." });
    expect(failure).not.toHaveProperty("cause");
    vi.spyOn(database, "$queryRaw").mockRejectedValueOnce(error);
    await expect(store.readCommandOperation(randomUUID())).rejects.toMatchObject({ status: 503, message: "Command coordination is unavailable." });
    vi.spyOn(database, "$executeRaw").mockRejectedValueOnce(error);
    await expect(store.markCommandDispatched(randomUUID())).rejects.toMatchObject({ status: 503, message: "Command coordination is unavailable." });
  });
});
