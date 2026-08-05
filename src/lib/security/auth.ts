import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { getSupabaseClient } from "@/lib/supabase/server";
import { appendAuditEvent } from "@/lib/security/audit";

export type WorkspaceRole = "owner" | "maintainer" | "viewer";

export type AuthSession = {
  userId: string;
  email?: string;
  role: WorkspaceRole;
  provider: "supabase" | "dev-token" | "disabled";
  authenticated: boolean;
};

const ROLE_PRECEDENCE: Record<WorkspaceRole, number> = {
  viewer: 1,
  maintainer: 2,
  owner: 3,
};

function parseIdList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function resolveRole(userId: string): WorkspaceRole {
  const owners = parseIdList(process.env.CR8OR_OWNER_IDS);
  const maintainers = parseIdList(process.env.CR8OR_MAINTAINER_IDS);

  if (owners.has(userId)) {
    return "owner";
  }
  if (maintainers.has(userId)) {
    return "maintainer";
  }
  return "viewer";
}

function getBearerToken(request: NextRequest): string | null {
  const auth = request.headers.get("authorization")?.trim() ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    return token || null;
  }

  const xToken = request.headers.get("x-cr8or-token")?.trim();
  return xToken || null;
}

export async function resolveAuthSession(request: NextRequest, authEnabled: boolean): Promise<AuthSession | null> {
  if (!authEnabled) {
    return {
      userId: "local-dev",
      role: "owner",
      provider: "disabled",
      authenticated: false,
    };
  }

  const token = getBearerToken(request);
  if (!token) {
    return null;
  }

  const devToken = process.env.CR8OR_DEV_API_TOKEN?.trim();
  if (devToken && token === devToken) {
    const userId = process.env.CR8OR_DEV_USER_ID?.trim() || "dev-user";
    return {
      userId,
      role: resolveRole(userId),
      provider: "dev-token",
      authenticated: true,
    };
  }

  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return null;
    }

    return {
      userId: data.user.id,
      email: data.user.email,
      role: resolveRole(data.user.id),
      provider: "supabase",
      authenticated: true,
    };
  } catch {
    return null;
  }
}

export function hasMinRole(session: AuthSession, minRole: WorkspaceRole): boolean {
  return ROLE_PRECEDENCE[session.role] >= ROLE_PRECEDENCE[minRole];
}

export function recordAccessDenied(input: {
  session: AuthSession | null;
  route: string;
  method: string;
  reason: string;
  requestId?: string;
}) {
  appendAuditEvent({
    id: randomUUID(),
    at: new Date().toISOString(),
    actorId: input.session?.userId ?? "anonymous",
    actorRole: input.session?.role ?? "none",
    action: "route.denied",
    outcome: "deny",
    route: input.route,
    method: input.method,
    reason: input.reason,
    requestId: input.requestId,
  });
}

export function recordAccessAllowed(input: {
  session: AuthSession;
  route: string;
  method: string;
  requestId?: string;
}) {
  appendAuditEvent({
    id: randomUUID(),
    at: new Date().toISOString(),
    actorId: input.session.userId,
    actorRole: input.session.role,
    action: "route.access",
    outcome: "allow",
    route: input.route,
    method: input.method,
    requestId: input.requestId,
  });
}
