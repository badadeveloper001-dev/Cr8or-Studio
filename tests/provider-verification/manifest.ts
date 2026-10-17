import { z } from "zod";

/** Compiled synthetic identities. This is not a live resource authorization. */
export const OFFLINE_MANIFEST = Object.freeze({
  version: 1,
  mode: "offline",
  suite: "critical-pilot-v1",
  repository: "cr8or-verification/pilot-fixture",
  branch: "pilot",
  sandboxes: ["offline-pilot-clone", "offline-pilot-execution", "offline-pilot-cancellation", "offline-pilot-uncertain-command", "offline-pilot-timeout"],
  database: "localhost:55432/cr8or_auth_test",
  maximumDurationSeconds: 300,
  maximumProviderOperations: 10_000,
  cleanup: "retain-fixtures-and-database",
});

const schema = z.object({
  version: z.literal(1), mode: z.literal("offline"), suite: z.literal("critical-pilot-v1"),
  repository: z.literal("cr8or-verification/pilot-fixture"), branch: z.literal("pilot"),
  sandboxes: z.tuple([z.literal("offline-pilot-clone"), z.literal("offline-pilot-execution"),
    z.literal("offline-pilot-cancellation"), z.literal("offline-pilot-uncertain-command"), z.literal("offline-pilot-timeout")]),
  database: z.literal("localhost:55432/cr8or_auth_test"), maximumDurationSeconds: z.literal(300),
  maximumProviderOperations: z.literal(10_000), cleanup: z.literal("retain-fixtures-and-database"),
}).strict();

export function validateOfflineManifest(value: unknown) {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("Only the compiled synthetic offline resource manifest is supported; live execution is unavailable.");
  return Object.freeze(result.data);
}

export function assertStandaloneEnvironment(env: NodeJS.ProcessEnv): void {
  const forbidden = ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_DEPLOYMENT_ID", "DATABASE_URL", "DIRECT_URL",
    "GITHUB_TOKEN", "GH_TOKEN", "DAYTONA_API_KEY", "CR8OR_PRIVATE_GITHUB_TOKEN", "CR8OR_PRIVATE_GITHUB_CLONE_TOKEN",
    "CR8OR_DAYTONA_PRIVATE_SNAPSHOT", "NODE_OPTIONS", "NODE_PATH"];
  if (env.NODE_ENV === "production" || forbidden.some(key => env[key] !== undefined)) {
    throw new Error("Use a fresh isolated process without deployment configuration or provider/application credentials.");
  }
}
