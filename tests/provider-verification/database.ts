import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import type { AuthSession } from "@/lib/security/auth";

const ORIGIN = "http://localhost:3000";
// Deliberately fixed: running the harness must not discover or apply future SQL.
const MIGRATIONS = [
  "0_init",
  "20250101000000_add_workspace_table",
  "20261015000000_authentication_foundation",
  "20261016000000_command_operations",
  "20261016010000_command_approvals",
  "20261016020000_git_operations",
  "20261017000000_workspace_lifecycle",
] as const;

export type HarnessDatabase = {
  readonly prisma: PrismaClient;
  readonly schemaName: string;
  createSession(): Promise<{ session: AuthSession; sessionId: string }>;
  /** Disconnect only. Retain reservations and synthetic records for inspection. */
  close(): Promise<void>;
};

export class HarnessDatabaseError extends Error {
  constructor(readonly schemaName: string | null = null) {
    super("The isolated harness database is unavailable; any created schema is retained for review.");
    this.name = "HarnessDatabaseError";
  }
}

/** No sockets, alternate hosts, search-path overrides, service files or redirects. */
export function validateHarnessDatabaseUrl(value: string): URL {
  let url: URL;
  try {
    if (typeof value !== "string" || value.length > 2_048 || value !== value.trim() || /[\r\n\t]/.test(value)) {
      throw new Error();
    }
    url = new URL(value);
    if (!["postgresql:", "postgres:"].includes(url.protocol) ||
        !["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== "55432" ||
        url.pathname !== "/cr8or_auth_test" || url.search || url.hash || /[?#]/.test(value)) {
      throw new Error();
    }
  } catch {
    throw new Error("The harness requires the isolated local cr8or_auth_test database on port 55432 without URL options.");
  }
  return url;
}

let opened = false;
function setEnvironment(key: string, value: string): void { process.env[key] = value; }

/**
 * Standalone runner only: call before importing any application server module.
 * No synthetic AuthSession objects or authorization mocks are constructed here.
 * The real password verifier, session persistence and cookie resolver are used.
 */
export async function openHarnessDatabase(value: string): Promise<HarnessDatabase> {
  const url = validateHarnessDatabaseUrl(value);
  if (opened || globalThis.prismaGlobal || process.env.NODE_ENV === "production" ||
      ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID"].some(key => process.env[key] !== undefined)) {
    throw new Error("The harness database requires a fresh, non-deployed standalone test process.");
  }
  // Never attempt to swap module-cached application clients after an open/failure.
  opened = true;
  const schemaName = `provider_verification_${randomBytes(16).toString("hex")}`;
  let admin: PrismaClient | undefined;
  let database: PrismaClient | undefined;
  let createdSchema: string | null = null;
  const syntheticAccessCode = `synthetic-fixture-${randomBytes(32).toString("hex")}`;
  try {
    const { PrismaClient } = await import("@prisma/client");
    admin = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
    // Identifier is generated above and cannot contain user input.
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    createdSchema = schemaName;
    await admin.$disconnect();
    admin = undefined;

    url.searchParams.set("schema", schemaName);
    url.searchParams.set("connection_limit", "5");
    process.env.DATABASE_URL = url.toString();
    process.env.DIRECT_URL = url.toString();
    setEnvironment("NODE_ENV", "test");
    process.env.CR8OR_PRIVATE_AUTH_ENABLED = "true";
    process.env.CR8OR_PRIVATE_AUTH_ORIGIN = ORIGIN;
    process.env.CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY = randomBytes(32).toString("base64url");
    process.env.CR8OR_FEATURE_AUTH_GUARD = "true";
    process.env.CR8OR_FEATURE_AUDIT_LOG = "false";
    process.env.CR8OR_POLICY_PROFILE = "balanced";
    delete process.env.CR8OR_WORKSPACE_MODE;

    database = (await import("@/lib/db/prisma")).prisma;
    const [location] = await database.$queryRaw<Array<{ schema: string; database: string }>>`
      SELECT current_schema() AS "schema", current_database() AS "database"
    `;
    if (location?.schema !== schemaName || location.database !== "cr8or_auth_test") throw new Error();
    for (const migration of MIGRATIONS) {
      const sql = await readFile(new URL(`../../prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8");
      // These reviewed migrations contain simple statements only. This is not a
      // general SQL parser or user-selectable migration/deployment facility.
      const statements = sql.replace(/^\s*--.*$/gm, "").split(";").map(statement => statement.trim())
        .filter(statement => statement && !/^(BEGIN|COMMIT)$/i.test(statement));
      await database.$transaction(async tx => {
        for (const statement of statements) await tx.$executeRawUnsafe(statement);
      });
    }
    const owners = await import("@/lib/security/owner-management");
    const credentials = await import("@/lib/security/access-code");
    const sessions = await import("@/lib/security/session-store");
    const auth = await import("@/lib/security/auth");
    const { NextRequest } = await import("next/server");
    await owners.provisionOwner(syntheticAccessCode);
    const prisma = database;
    let closed = false;
    return {
      prisma,
      schemaName,
      async createSession() {
        if (closed) throw new HarnessDatabaseError(schemaName);
        try {
          const owner = await prisma.ownerCredential.findUniqueOrThrow({ where: { id: "owner" } });
          if (!await credentials.verifyAccessCode(syntheticAccessCode, owner.accessCodeHash)) throw new Error();
          const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
            SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"
          `;
          const created = await sessions.createOwnerSession({ credentialVersion: owner.credentialVersion,
            authenticationMethod: "ACCESS_CODE", expiresAt: new Date(clock.now.getTime() + 60 * 60 * 1_000) });
          // Token exists only in this local call and never enters evidence or adapters.
          const request = new NextRequest(`${ORIGIN}/api/auth/session`, {
            headers: { cookie: `cr8or-dev-session=${created.token}` },
          });
          const session = await auth.resolveAuthSession(request, false);
          if (!session || !auth.isVerifiedPrivateOwnerSession(session) ||
              !await auth.revalidatePrivateOwnerSession(session)) throw new Error();
          return { session, sessionId: created.session.id };
        } catch {
          throw new HarnessDatabaseError(schemaName);
        }
      },
      async close() {
        closed = true;
        // No DROP, owner/session deletion or UNKNOWN reservation recovery.
        try { await prisma.$disconnect(); } catch { throw new HarnessDatabaseError(schemaName); }
      },
    };
  } catch {
    await Promise.allSettled([admin?.$disconnect(), database?.$disconnect()]);
    throw new HarnessDatabaseError(createdSchema);
  }
}
