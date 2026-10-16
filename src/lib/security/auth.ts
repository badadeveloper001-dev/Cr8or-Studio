import "server-only";

import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { getSupabaseClient } from "@/lib/supabase/server";
import { appendAuditEvent } from "@/lib/security/audit";
import { getPrivateAuthMode } from "@/lib/security/private-auth-mode";
import { readPrivateAuthConfig, readSessionToken } from "@/lib/security/private-auth-http";
import { resolveOwnerSession, resolveSessionById } from "@/lib/security/session-store";

// A fresh context carries provenance from this resolver, never client-supplied
// roles or IDs. The marker is not serialized, and stores no authorization cache.
const VERIFIED_PRIVATE_OWNER = Symbol("verified-private-owner");
const REVALIDATE_PRIVATE_OWNER = Symbol("revalidate-private-owner");
const MINT_PRIVATE_PROOF = Symbol("mint-private-proof");

class PrivateOwnerProof {
  #session: AuthSession;
  #id: string;
  #version: number;
  constructor(key: symbol, session: AuthSession, id: string, version: number) {
    if (key !== MINT_PRIVATE_PROOF) throw new Error("Invalid owner proof.");
    this.#session = session;
    this.#id = id;
    this.#version = version;
    Object.freeze(this);
  }
  static matches(proof: PrivateOwnerProof | undefined, candidate: AuthSession): proof is PrivateOwnerProof {
    return !!proof && typeof proof === "object" && #session in proof && proof.#session === candidate;
  }
  static async validate(proof: PrivateOwnerProof | undefined, candidate: AuthSession): Promise<boolean> {
    if (!PrivateOwnerProof.matches(proof, candidate)) return false;
    readPrivateAuthConfig();
    const current = await resolveSessionById(proof.#id);
    return current !== null && current.ownerId === "owner" && current.credentialVersion === proof.#version;
  }
}

export type WorkspaceRole = "owner" | "maintainer" | "viewer";

export type AuthSession = {
  userId: string;
  email?: string;
  role: WorkspaceRole;
  provider: "supabase" | "dev-token" | "disabled" | "private-session";
  authenticated: boolean;
  readonly [VERIFIED_PRIVATE_OWNER]?: true;
  readonly [REVALIDATE_PRIVATE_OWNER]?: PrivateOwnerProof;
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
  // Private configuration always takes precedence over legacy feature flags and
  // tokens. Configuration/database errors propagate; they must never fall back.
  if (getPrivateAuthMode() === "required") {
    const config = readPrivateAuthConfig();
    const token = readSessionToken(request, config);
    if (!token) return null;
    const ownerSession = await resolveOwnerSession(token);
    if (!ownerSession || ownerSession.ownerId !== "owner") return null;

    const session: AuthSession = {
      userId: "owner",
      role: "owner",
      provider: "private-session",
      authenticated: true,
    };
    Object.defineProperty(session, VERIFIED_PRIVATE_OWNER, { value: true });
    // The database reference is confined to private fields. It cannot appear in
    // JSON, prompts, tool arguments, external runtimes, or a client DTO. Copying
    // symbol properties onto a fabricated object does not transfer the proof.
    Object.defineProperty(session, REVALIDATE_PRIVATE_OWNER, {
      value: new PrivateOwnerProof(MINT_PRIVATE_PROOF, session, ownerSession.id, ownerSession.credentialVersion),
    });
    return Object.freeze(session);
  }

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
  if (getPrivateAuthMode() === "required" || session.provider === "private-session") {
    return isVerifiedPrivateOwnerSession(session) && ROLE_PRECEDENCE.owner >= ROLE_PRECEDENCE[minRole];
  }
  return ROLE_PRECEDENCE[session.role] >= ROLE_PRECEDENCE[minRole];
}

/** Only contexts returned after this request's PostgreSQL validation qualify. */
export function isVerifiedPrivateOwnerSession(session: AuthSession): boolean {
  if (!session || typeof session !== "object") return false;
  return session[VERIFIED_PRIVATE_OWNER] === true && session.provider === "private-session" &&
    session.authenticated === true && session.userId === "owner" && session.role === "owner" &&
    PrivateOwnerProof.matches(session[REVALIDATE_PRIVATE_OWNER], session);
}

/** No cached authorization: every invocation checks PostgreSQL and its clock. */
export async function revalidatePrivateOwnerSession(session: AuthSession): Promise<boolean> {
  if (!isVerifiedPrivateOwnerSession(session)) return false;
  return PrivateOwnerProof.validate(session[REVALIDATE_PRIVATE_OWNER], session);
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
