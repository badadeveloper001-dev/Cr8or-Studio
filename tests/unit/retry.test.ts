import { describe, expect, it, vi } from "vitest";

import { isTransientHttpStatus, withRetry } from "@/lib/reliability/retry";

describe("withRetry", () => {
  it("returns on first success", async () => {
    const operation = vi.fn(async () => "ok");
    const value = await withRetry(operation, { retries: 2 });

    expect(value).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries until success", async () => {
    let attempts = 0;
    const value = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("temporary");
        return "done";
      },
      { retries: 3, minDelayMs: 1, maxDelayMs: 2 },
    );

    expect(value).toBe("done");
    expect(attempts).toBe(3);
  });

  it("stops when shouldRetry returns false", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new Error("fatal");
        },
        {
          retries: 3,
          minDelayMs: 1,
          maxDelayMs: 1,
          shouldRetry: () => false,
        },
      ),
    ).rejects.toThrow("fatal");

    expect(attempts).toBe(1);
  });
});

describe("isTransientHttpStatus", () => {
  it("detects transient statuses", () => {
    expect(isTransientHttpStatus(429)).toBe(true);
    expect(isTransientHttpStatus(500)).toBe(true);
    expect(isTransientHttpStatus(503)).toBe(true);
    expect(isTransientHttpStatus(404)).toBe(false);
  });
});
