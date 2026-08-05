import { describe, expect, it } from "vitest";

const BASE_URL = process.env.CR8OR_TEST_BASE_URL;

describe("github api smoke", () => {
  it("is skippable without runtime env", async () => {
    if (!BASE_URL) {
      expect(true).toBe(true);
      return;
    }

    const response = await fetch(`${BASE_URL}/api/github/api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "list-repos" }),
    });

    expect([200, 400, 401, 403]).toContain(response.status);
  });
});
