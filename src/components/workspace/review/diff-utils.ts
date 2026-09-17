export type DiffLineType = "add" | "del" | "context";

export type DiffRow = {
  type: DiffLineType;
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
};

export type DiffHunk = {
  header: string;
  rows: DiffRow[];
};

export type ParsedDiff = {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  binary: boolean;
  empty: boolean;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(raw: string): ParsedDiff {
  const normalized = (raw ?? "").replace(/\r\n?/g, "\n");
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let binary = false;
  let current: DiffHunk | null = null;
  let oldNumber = 0;
  let newNumber = 0;

  for (const line of normalized.split("\n")) {
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true;
      continue;
    }

    if (line.startsWith("diff --git ")) {
      current = null;
      continue;
    }

    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldNumber = Number(hunk[1]);
      newNumber = Number(hunk[2]);
      current = { header: line, rows: [] };
      hunks.push(current);
      continue;
    }

    if (!current) continue;
    if (line.startsWith("\\")) continue;

    if (line.startsWith("+")) {
      current.rows.push({ type: "add", text: line.slice(1), oldNumber: null, newNumber });
      newNumber += 1;
      additions += 1;
      continue;
    }

    if (line.startsWith("-")) {
      current.rows.push({ type: "del", text: line.slice(1), oldNumber, newNumber: null });
      oldNumber += 1;
      deletions += 1;
      continue;
    }

    const text = line.startsWith(" ") ? line.slice(1) : line;
    current.rows.push({ type: "context", text, oldNumber, newNumber });
    oldNumber += 1;
    newNumber += 1;
  }

  return {
    hunks,
    additions,
    deletions,
    binary,
    empty: normalized.trim().length === 0,
  };
}

export type GitStatusDescriptor = {
  code: string;
  label: string;
  tone: string;
};

const STATUS_TONES: Record<string, string> = {
  add: "text-success",
  delete: "text-danger",
  modify: "text-warning",
  rename: "text-accent",
  conflict: "text-danger",
  neutral: "text-text-muted",
};

const STATUS_LOOKUP: Record<string, { label: string; tone: keyof typeof STATUS_TONES }> = {
  "??": { label: "Untracked", tone: "add" },
  A: { label: "Added", tone: "add" },
  M: { label: "Modified", tone: "modify" },
  MM: { label: "Modified", tone: "modify" },
  AM: { label: "Added", tone: "add" },
  D: { label: "Deleted", tone: "delete" },
  R: { label: "Renamed", tone: "rename" },
  RM: { label: "Renamed", tone: "rename" },
  C: { label: "Copied", tone: "rename" },
  T: { label: "Type changed", tone: "modify" },
  U: { label: "Conflict", tone: "conflict" },
  UU: { label: "Conflict", tone: "conflict" },
  AA: { label: "Conflict", tone: "conflict" },
  DD: { label: "Conflict", tone: "conflict" },
};

export function describeGitStatus(status: string): GitStatusDescriptor {
  const raw = (status || "?").trim();
  const match = STATUS_LOOKUP[raw];
  if (match) {
    return { code: raw, label: match.label, tone: STATUS_TONES[match.tone] };
  }
  return { code: raw, label: raw || "Changed", tone: STATUS_TONES.neutral };
}
