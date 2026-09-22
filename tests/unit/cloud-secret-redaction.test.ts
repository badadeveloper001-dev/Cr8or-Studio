import { afterEach, expect, it, vi } from "vitest";
import { redactText } from "@/lib/security/redaction";
import { internalErrorResponse } from "@/lib/http/api-response";
afterEach(() => vi.unstubAllEnvs());
it("redacts configured cloud credentials from provider and API errors", async () => {
  vi.stubEnv("DAYTONA_API_KEY", "daytona-test-secret");
  vi.stubEnv("DATABASE_URL", "postgres://user:password@host/db");
  const input = `Could not connect: ${process.env.DATABASE_URL}, key=${process.env.DAYTONA_API_KEY}`;
  expect(redactText(input)).not.toContain("password");
  const response = await internalErrorResponse(input).text();
  expect(response).not.toContain("daytona-test-secret");
  expect(response).not.toContain("postgres://");
});
