import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import { createJiti } from "jiti";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const nextCli = fileURLToPath(import.meta.resolve("next/dist/bin/next"));
const origin = "https://studio.example.test";
// Public synthetic fixtures, exclusively for the disposable local test schema.
const accessCode = "public-synthetic-authorization-http-code";
const legacyToken = "public-synthetic-legacy-http-token";
const projectId = "synthetic-http-existing-project";

class VerificationError extends Error {}

function isolatedDatabaseUrl() {
  // Never select a service from DATABASE_URL, DIRECT_URL, or an environment file.
  const value = process.env.CR8OR_AUTH_TEST_DATABASE_URL;
  if (!value) throw new VerificationError("The isolated authentication test database must be explicitly configured.");
  const url = new URL(value);
  if (!["postgresql:", "postgres:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.port !== "55432" || url.pathname !== "/cr8or_auth_test") {
    throw new VerificationError("HTTP verification requires the isolated local authentication test database.");
  }
  url.search = "";
  return url;
}

function assert(condition, label) {
  if (!condition) throw new VerificationError(label);
}

function expectResponse(response, status, label, noStore = true) {
  assert(response.status === status, `${label}: unexpected HTTP status ${response.status}.`);
  if (noStore) assert(response.headers.get("cache-control") === "no-store", `${label}: missing no-store.`);
}

async function availablePort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function childEnvironment(databaseUrl, mode) {
  const env = { ...process.env };
  // Do not inherit authentication staging values or react-server NODE_OPTIONS.
  // Explicit database values also take precedence over Next's environment files.
  for (const name of Object.keys(env)) {
    if (name.startsWith("CR8OR_") || name.startsWith("VERCEL") ||
        name === "NODE_OPTIONS" || name === "DATABASE_URL" || name === "DIRECT_URL") delete env[name];
  }
  Object.assign(env, {
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    DATABASE_URL: databaseUrl,
    DIRECT_URL: databaseUrl,
    CR8OR_FEATURE_AUTH_GUARD: "false",
    CR8OR_FEATURE_SLI_ENDPOINT: "true",
    CR8OR_DEV_API_TOKEN: legacyToken,
  });
  if (mode === "active") {
    Object.assign(env, {
      CR8OR_PRIVATE_AUTH_ENABLED: "true",
      CR8OR_PRIVATE_AUTH_ORIGIN: origin,
      CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY: randomBytes(32).toString("base64url"),
    });
  } else if (mode === "partial") {
    // A disabled flag with leftover private configuration must fail closed.
    env.CR8OR_PRIVATE_AUTH_ENABLED = "false";
    env.CR8OR_PRIVATE_AUTH_ORIGIN = origin;
  }
  return env;
}

async function startServer(databaseUrl, mode) {
  const port = await availablePort();
  const child = spawn(process.execPath, [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repositoryRoot,
    env: childEnvironment(databaseUrl, mode),
    // Never forward server logs or request/error material to the test output.
    stdio: "ignore",
  });
  let spawnFailed = false;
  child.once("error", () => { spawnFailed = true; });
  let closed = false;
  const close = new Promise((resolve) => child.once("close", () => { closed = true; resolve(); }));
  const request = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    ...init, redirect: "manual", signal: AbortSignal.timeout(10_000),
  });
  const stop = async () => {
    if (closed) return;
    child.kill("SIGTERM");
    const exited = await Promise.race([close.then(() => true), delay(5_000).then(() => false)]);
    if (!exited) {
      child.kill("SIGKILL");
      await close;
    }
  };
  try {
    const deadline = Date.now() + 55_000;
    while (Date.now() < deadline) {
      if (spawnFailed || closed) throw new Error("The built Next.js server could not start.");
      try {
        // Startup readiness accepts any HTTP status; assertions below verify policy.
        await fetch(`http://127.0.0.1:${port}/api/auth/session`, { signal: AbortSignal.timeout(1_000) });
        return { request, stop };
      } catch {
        await delay(200);
      }
    }
    throw new Error("The built Next.js server did not become ready within 60 seconds.");
  } catch (error) {
    await stop();
    throw error;
  }
}

async function applyMigrations(database) {
  for (const directory of ["0_init", "20250101000000_add_workspace_table", "20261015000000_authentication_foundation",
    "20261016000000_command_operations", "20261016010000_command_approvals"]) {
    const sql = await readFile(join(repositoryRoot, "prisma/migrations", directory, "migration.sql"), "utf8");
    // These existing migrations are ordinary DDL with no semicolons in SQL literals.
    const statements = sql.replace(/^\s*--.*$/gm, "").split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement && !/^(BEGIN|COMMIT)$/i.test(statement));
    await database.$transaction(async (transaction) => {
      for (const statement of statements) await transaction.$executeRawUnsafe(statement);
    });
  }
}

async function checkActiveServer(server, database) {
  const { request } = server;
  for (const [label, headers] of [
    ["missing session", {}],
    ["forged session", { cookie: `__Host-cr8or-session=${randomBytes(32).toString("base64url")}` }],
    ["legacy authentication", {
      cookie: `cr8or-dev-session=${randomBytes(32).toString("base64url")}`,
      authorization: `Bearer ${legacyToken}`, "x-cr8or-token": legacyToken,
    }],
  ]) {
    expectResponse(await request("/api/projects", { headers }), 401, label);
  }
  expectResponse(await request("/api/auth/session/extra"), 401, "nested auth route");
  expectResponse(await request("/api/auth/unlock"), 405, "unsupported auth method");
  expectResponse(await request("/api/auth/session", { method: "OPTIONS" }), 405, "unsupported auth OPTIONS");
  const unauthenticated = await request("/api/auth/session");
  expectResponse(unauthenticated, 200, "public session status");
  assert((await unauthenticated.json()).authenticated === false, "Public session status was incorrect.");
  console.log("PASS: Compiled middleware rejects missing, forged, and legacy authentication; exact public methods remain available.");

  const mutationHeaders = { origin, "x-cr8or-auth": "1", "content-type": "application/json" };
  const unlocked = await request("/api/auth/unlock", {
    method: "POST", headers: mutationHeaders, body: JSON.stringify({ accessCode }),
  });
  expectResponse(unlocked, 200, "unlock");
  const setCookie = unlocked.headers.get("set-cookie") ?? "";
  assert(setCookie.startsWith("__Host-cr8or-session=") &&
    /;\s*Secure(?:;|$)/i.test(setCookie) && /;\s*HttpOnly(?:;|$)/i.test(setCookie) &&
    /;\s*SameSite=Strict(?:;|$)/i.test(setCookie) && /;\s*Path=\/(?:;|$)/i.test(setCookie) &&
    !/;\s*Domain=/i.test(setCookie), "Unlock did not issue the required secure cookie.");
  const cookie = setCookie.split(";", 1)[0];
  const unlockBody = await unlocked.json();
  assert(unlockBody.authenticated === true &&
    Object.keys(unlockBody).sort().join(",") === "authenticated,expiresAt,ok", "Unlock response exposed unexpected data.");
  const projects = await request("/api/projects", { headers: { cookie } });
  expectResponse(projects, 200, "authenticated project read");
  assert((await projects.json()).some((project) => project.id === projectId), "Existing project identity was not preserved.");
  expectResponse(await request("/api/projects", { method: "HEAD", headers: { cookie } }), 200, "authenticated HEAD");
  const options = await request("/api/projects", { method: "OPTIONS", headers: { cookie } });
  expectResponse(options, 204, "authenticated OPTIONS");
  assert(options.headers.get("allow") === "GET, HEAD, OPTIONS, POST", "OPTIONS did not preserve supported methods.");
  console.log("PASS: Actual unlock and secure cookies authorize GET, HEAD, and OPTIONS without changing existing project IDs.");

  // A synthetic registry row, not a real Daytona sandbox. Approval resolution
  // is database-only and must never contact a provider or execute a command.
  const commandProject = `${projectId}-command-approval`;
  const commandWorkspace = "synthetic-daytona-command-approval";
  await database.project.create({ data: {
    id: commandProject, name: "Synthetic command approval", description: "Disposable HTTP scope fixture",
    framework: "Next.js", language: "TypeScript", workspaces: { create: {
      runtimeType: "cloud", provider: "daytona", providerWorkspaceId: commandWorkspace, state: "running",
    } },
  } });
  const approvalRequest = { intent: "request", payload: {
    action: "commands.execute", projectId: commandProject, commandKey: "npm run lint",
  } };
  const approvalHeaders = { ...mutationHeaders, cookie };
  expectResponse(await request("/api/security/approvals", { method: "POST", headers: approvalHeaders,
    body: JSON.stringify({ ...approvalRequest, payload: { ...approvalRequest.payload,
      providerWorkspaceId: "client-forged-workspace", title: "Trust this preview" } }) }), 400, "forged approval scope");
  expectResponse(await request("/api/security/approvals", { method: "POST",
    headers: { ...approvalHeaders, origin: "https://untrusted.example.test" },
    body: JSON.stringify(approvalRequest) }), 400, "cross-origin approval request");
  const createdApproval = await request("/api/security/approvals", { method: "POST", headers: approvalHeaders,
    body: JSON.stringify(approvalRequest) });
  expectResponse(createdApproval, 201, "scoped command approval creation");
  const approval = (await createdApproval.json()).approval;
  const expectedScope = { ownerId: "owner", projectId: commandProject,
    providerWorkspaceId: commandWorkspace, commandKey: "npm run lint" };
  assert(JSON.stringify(approval.scope) === JSON.stringify(expectedScope) &&
    approval.preview === JSON.stringify(expectedScope, null, 2), "Approval preview did not match the trusted scope.");
  const reviewText = JSON.stringify(approval);
  assert(!reviewText.includes("sessionId") && !reviewText.includes("credentialVersion") &&
    !reviewText.includes(cookie.split("=", 2)[1]), "Approval review exposed internal authentication data.");
  const decisionRequest = { intent: "decide", payload: { id: approval.id, decision: "approved" } };
  expectResponse(await request("/api/security/approvals", { method: "POST", headers: approvalHeaders,
    body: JSON.stringify(decisionRequest) }), 200, "scoped command approval decision");
  const listedApprovals = await request("/api/security/approvals", { headers: { cookie } });
  expectResponse(listedApprovals, 200, "scoped command approval list");
  assert((await listedApprovals.json()).approvals.some((item) => item.id === approval.id && item.status === "approved"),
    "Approved command scope was missing from owner review.");
  await database.workspace.update({ where: { projectId: commandProject }, data: { providerWorkspaceId: "synthetic-remapped-sandbox" } });
  expectResponse(await request("/api/security/approvals", { method: "POST", headers: approvalHeaders,
    body: JSON.stringify(decisionRequest) }), 409, "remapped command approval scope");
  await database.$executeRawUnsafe('ALTER TABLE "CommandApproval" RENAME TO "CommandApprovalUnavailable"');
  try {
    expectResponse(await request("/api/security/approvals", { headers: { cookie } }), 503, "unavailable approval infrastructure");
  } finally {
    await database.$executeRawUnsafe('ALTER TABLE "CommandApprovalUnavailable" RENAME TO "CommandApproval"');
  }
  console.log("PASS: Compiled scoped approval handlers resolve exact operation scope, reject forged/remapped scopes and fail closed on database outage.");

  expectResponse(await request("/api/projects", {
    method: "POST", headers: { ...mutationHeaders, cookie, origin: "https://untrusted.example.test" }, body: "{}",
  }), 400, "cross-origin mutation");
  for (const path of ["/api/chat/main", "/api/orchestrate", "/api/orchestrate/stream"]) {
    expectResponse(await request(path, {
      method: "POST", headers: { ...mutationHeaders, cookie }, body: "{}",
    }), 400, "execution requires a registered project");
    expectResponse(await request(path, {
      method: "POST", headers: { ...mutationHeaders, cookie },
      body: JSON.stringify({ projectId: "unknown-project", prompt: "Synthetic execution request", message: "Read package.json" }),
    }), 404, "unknown execution project");
  }
  // This failure is confined to the disposable schema, never a production table.
  await database.$executeRawUnsafe('ALTER TABLE "AuthSession" RENAME TO "AuthSessionUnavailable"');
  try {
    expectResponse(await request("/api/projects", { headers: { cookie } }), 503, "unavailable session infrastructure");
  } finally {
    await database.$executeRawUnsafe('ALTER TABLE "AuthSessionUnavailable" RENAME TO "AuthSession"');
  }
  expectResponse(await request("/api/auth/lock", {
    method: "POST", headers: { ...mutationHeaders, cookie },
  }), 204, "lock");
  expectResponse(await request("/api/projects", { headers: { cookie } }), 401, "revoked session");
  console.log("PASS: Origin failures, missing or unknown execution projects, database failures, and revoked sessions fail closed.");
}

async function main() {
  const url = isolatedDatabaseUrl();
  // Missing environment keys must stay missing in the inactive test. Next would
  // otherwise fill them from local files, possibly loading unrelated credentials.
  for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    let exists = false;
    try {
      await access(join(repositoryRoot, file));
      exists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (exists) throw new VerificationError("Run HTTP verification in an isolated checkout without local environment files.");
  }
  const admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const schemaName = `auth_http_test_${randomBytes(8).toString("hex")}`;
  const savedEnvironment = new Map(["DATABASE_URL", "DIRECT_URL", "NODE_ENV"].map((name) => [name, process.env[name]]));
  const savedPrisma = globalThis.prismaGlobal;
  let schemaCreated = false;
  let database;
  let fixtureDatabase;
  let server;
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    schemaCreated = true;
    url.searchParams.set("schema", schemaName);
    url.searchParams.set("connection_limit", "5");
    database = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await applyMigrations(database);
    process.env.DATABASE_URL = url.toString();
    process.env.DIRECT_URL = url.toString();
    process.env.NODE_ENV = "test";
    delete globalThis.prismaGlobal;
    const jiti = createJiti(import.meta.url, {
      alias: {
        "@": fileURLToPath(new URL("../src", import.meta.url)),
        "server-only": fileURLToPath(import.meta.resolve("server-only")),
      },
    });
    fixtureDatabase = (await jiti.import("../src/lib/db/prisma.ts")).prisma;
    const { provisionOwner } = await jiti.import("../src/lib/security/owner-management.ts");
    await provisionOwner(accessCode);
    await database.project.create({ data: {
      id: projectId, name: "Synthetic existing project", description: "Local HTTP fixture",
      framework: "Next.js", language: "TypeScript",
    } });

    server = await startServer(url.toString(), "active");
    await checkActiveServer(server, database);
    await server.stop();
    server = await startServer(url.toString(), "partial");
    expectResponse(await server.request("/api/projects"), 503, "partial private configuration");
    await server.stop();
    server = await startServer(url.toString(), "inactive");
    expectResponse(await server.request("/api/health/slis"), 200, "inactive deployment compatibility", false);
    console.log("PASS: Partial configuration fails closed; fully inactive configuration preserves the existing deployment.");
  } finally {
    const cleanup = await Promise.allSettled([
      server?.stop(), fixtureDatabase?.$disconnect(), database?.$disconnect(),
    ]);
    try {
      if (schemaCreated) await admin.$executeRawUnsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
    } finally {
      try {
        await admin.$disconnect();
      } finally {
        for (const [name, value] of savedEnvironment) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        if (savedPrisma === undefined) delete globalThis.prismaGlobal;
        else globalThis.prismaGlobal = savedPrisma;
      }
    }
    assert(cleanup.every((result) => result.status === "fulfilled"), "HTTP verification could not fully clean up its local resources.");
  }
}

try {
  await main();
} catch (error) {
  // Only our fixed assertion labels are safe; never print Prisma/URL/server data.
  const message = error instanceof VerificationError ? error.message : "Private authorization HTTP verification failed.";
  console.error(message);
  process.exitCode = 1;
}
