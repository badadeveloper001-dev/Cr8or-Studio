import { describe, expect, it } from "vitest";

import { redactText } from "@/lib/security/redaction";

describe("redactText", () => {
  it("redacts generic token-like patterns", () => {
    const text = "token=ghp_abcdefghijklmnopqrstuvwxyz123456 and sk-1234567890abcdef";
    const redacted = redactText(text);

    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain("sk-1234567890abcdef");
    expect(redacted).toContain("[REDACTED");
  });
});
