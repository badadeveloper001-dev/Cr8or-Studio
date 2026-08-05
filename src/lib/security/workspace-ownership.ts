import { AuthSession } from "@/lib/security/auth";

type WorkspaceOwnerMap = Record<string, string[]>;

function parseOwnershipMap(raw: string | undefined): WorkspaceOwnerMap {
  if (!raw?.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const entries = Object.entries(parsed as Record<string, unknown>).map(([workspaceId, owners]) => {
      const ownerIds = Array.isArray(owners)
        ? owners.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
        : [];
      return [workspaceId, ownerIds] as const;
    });

    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function getWorkspaceOwnerMap(): WorkspaceOwnerMap {
  return parseOwnershipMap(process.env.CR8OR_WORKSPACE_OWNERS_JSON);
}

export function isWorkspaceOwner(session: AuthSession, workspaceId: string): boolean {
  if (session.role === "owner") {
    return true;
  }

  const map = getWorkspaceOwnerMap();
  const owners = map[workspaceId] ?? [];
  return owners.includes(session.userId);
}
