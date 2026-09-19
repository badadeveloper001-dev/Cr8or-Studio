import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

declare global {
  var prismaGlobal: PrismaClient | undefined;
  var _migrationAttempted: boolean | undefined;
}

function runMigrationOnce() {
  if (global._migrationAttempted) return;
  global._migrationAttempted = true;
  if (!process.env.DATABASE_URL) return;
  try {
    execSync("npx prisma migrate deploy", {
      stdio: "ignore",
      timeout: 30_000,
      env: { ...process.env, NODE_ENV: "production" },
    });
  } catch {
    // Migration failed — first DB query will surface the actual error
    // (P1001 = connection issue, P2021 = missing table, etc.)
  }
}

export const prisma =
  global.prismaGlobal ??
  new PrismaClient({
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  global.prismaGlobal = prisma;
} else {
  runMigrationOnce();
}
