import { describe, expect, it } from "vitest";

import { requestApproval, decideApproval } from "@/lib/security/approvals";
import { evaluatePolicyGuard, setPolicyProfile } from "@/lib/security/policy";

describe("policy + approvals", () => {
  it("requires approval for high-risk action in balanced profile", () => {
    setPolicyProfile("balanced");

    const denied = evaluatePolicyGuard({
      action: "deploy.vercel",
      actorId: "u1",
      actorRole: "owner",
    });

    expect(denied.allowed).toBe(false);
    if (denied.allowed) return;
    expect(denied.approvalRequired).toBe(true);
  });

  it("allows high-risk action after approval consumption", () => {
    setPolicyProfile("balanced");

    const approval = requestApproval({
      action: "deploy.vercel",
      title: "Deploy prod",
      preview: "npx vercel --prod --yes",
      requestedBy: "u1",
      requestedRole: "owner",
    });

    const decided = decideApproval({
      id: approval.id,
      decision: "approved",
      decidedBy: "u1",
      decidedRole: "owner",
    });

    expect(decided?.status).toBe("approved");

    const allowed = evaluatePolicyGuard({
      action: "deploy.vercel",
      actorId: "u1",
      actorRole: "owner",
      approvalId: approval.id,
    });

    expect(allowed.allowed).toBe(true);
  });
});
