import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ clients: 0 }));
vi.mock("@prisma/client", () => ({ PrismaClient: class {
  constructor() { calls.clients += 1; throw new Error("synthetic-connection-secret-must-not-escape"); }
} }));

const DATABASE = "postgresql://synthetic:synthetic@127.0.0.1:55432/cr8or_auth_test";
const previousGlobal = globalThis.prismaGlobal;

beforeEach(() => {
  calls.clients = 0;
  vi.resetModules();
  delete globalThis.prismaGlobal;
  vi.stubEnv("NODE_ENV", "test");
  for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID"]) vi.stubEnv(key, undefined);
});
afterEach(() => { vi.unstubAllEnvs(); globalThis.prismaGlobal = previousGlobal; });

describe("standalone provider harness database boundary (offline, no database connection)", () => {
  it.each([DATABASE, "postgres://synthetic@localhost:55432/cr8or_auth_test"])("accepts the fixed disposable target %s", async value => {
    const { validateHarnessDatabaseUrl } = await import("../provider-verification/database");
    expect(validateHarnessDatabaseUrl(value).pathname).toBe("/cr8or_auth_test");
    expect(calls.clients).toBe(0);
  });

  it.each([
    "postgresql://synthetic:synthetic@production.example:55432/cr8or_auth_test",
    "postgresql://synthetic@localhost:5432/cr8or_auth_test",
    "postgresql://synthetic@localhost:55432/production",
    "postgresql://synthetic@localhost:55432/cr8or_auth_test/",
    "postgresql://synthetic@[::1]:55432/cr8or_auth_test",
    "postgresql://synthetic@127.1:55432/cr8or_auth_test",
    "postgresql://synthetic@localhost.:55432/cr8or_auth_test",
    "postgresql://synthetic@%6cocalhost:55432/cr8or_auth_test",
    "postgresql://synthetic@localhost:55432/cr8or_auth_test?host=production.example",
    "postgresql://synthetic@localhost:55432/cr8or_auth_test?host=/tmp/production-socket",
    "postgresql://synthetic@localhost:55432/cr8or_auth_test?schema=public",
    "postgresql://synthetic@localhost:55432/cr8or_auth_test?options=-csearch_path%3Dpublic",
    "postgresql://synthetic@localhost:55432/cr8or_auth_test?pgbouncer=true",
    "postgresql://synthetic@localhost:55432/cr8or_auth_test?sslcert=production.pem",
    "postgresql://synthetic@localhost:55432/cr8or_auth_test?",
    "postgresql://synthetic@localhost:55432/cr8or_auth_test#",
    "postgresql://synthetic@localhost:55432/cr8or_auth_test#host=production.example",
    "postgresql://synthetic@localhost:55432/cr8or_auth_test%00",
    "http://synthetic@localhost:55432/cr8or_auth_test",
    `${DATABASE}\n`, ` ${DATABASE}`, DATABASE.replace("localhost", "production.example") + "\t",
    "not a URL", "", "x".repeat(2_049),
  ])("rejects an unsafe URL before opening a client: %s", async value => {
    const { openHarnessDatabase } = await import("../provider-verification/database");
    await expect(openHarnessDatabase(value)).rejects.toThrow("isolated local");
    expect(calls.clients).toBe(0);
  });

  it.each(["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID"])("refuses a deployed process identified by %s", async key => {
    vi.stubEnv(key, "synthetic");
    const { openHarnessDatabase } = await import("../provider-verification/database");
    await expect(openHarnessDatabase(DATABASE)).rejects.toThrow("standalone test process");
    expect(calls.clients).toBe(0);
  });

  it("refuses production Node mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { openHarnessDatabase } = await import("../provider-verification/database");
    await expect(openHarnessDatabase(DATABASE)).rejects.toThrow("standalone test process");
    expect(calls.clients).toBe(0);
  });

  it("refuses to replace an existing application client", async () => {
    globalThis.prismaGlobal = {} as PrismaClient;
    const { openHarnessDatabase } = await import("../provider-verification/database");
    await expect(openHarnessDatabase(DATABASE)).rejects.toThrow("standalone test process");
    expect(calls.clients).toBe(0);
  });

  it("sanitizes infrastructure failures and refuses retry in a module-cached process", async () => {
    const { openHarnessDatabase, HarnessDatabaseError } = await import("../provider-verification/database");
    const error = await openHarnessDatabase(DATABASE).catch(value => value);
    expect(error).toBeInstanceOf(HarnessDatabaseError);
    expect(error.schemaName).toBeNull();
    expect(String(error)).not.toContain("synthetic-connection-secret");
    expect(String(error)).not.toContain(DATABASE);
    await expect(openHarnessDatabase(DATABASE)).rejects.toThrow("standalone test process");
    expect(calls.clients).toBe(1);
  });
});
