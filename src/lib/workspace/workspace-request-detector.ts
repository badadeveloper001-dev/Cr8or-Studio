type WorkspaceRequestType = "read_file" | "list_files" | "git_status" | "git_diff" | "inspect_project" | "check_readiness" | null;

export interface WorkspaceRequest {
  type: WorkspaceRequestType;
  path?: string;
}

const READ_FILE_PATTERNS = [
  /^(?:read|open|cat|view|display)\s+['"]?([\w./\\-]+(?:\.\w+)?)['"]?\s*(?:\s+and\s+.*)?$/i,
  /^show\s+me\s+['"]?([\w./\\-]+(?:\.\w+)?)['"]?\s*$/i,
  /^(?:what(?:'s| is) in|what does)\s+['"]?([\w./\\-]+(?:\.\w+)?)['"]?\s*$/i,
];

const LIST_PATTERNS = [
  /^(?:list|ls|dir)\s+(?:the\s+)?(?:files?|directory|folder|project\s+files?)\s*$/i,
  /^(?:show|display)\s+(?:the\s+)?(?:project\s+)?(?:root|directory|folder|files?)\s*$/i,
  /^(?:what(?:'s| is) in)\s+(?:the\s+)?(?:project|root|directory|folder)\s*$/i,
  /^files?\s*$/i,
  /^project\s+files?\s*$/i,
];

const GIT_STATUS_PATTERNS = [
  /^git\s+status\s*$/i,
  /^(?:show|display|get)\s+(?:the\s+)?(?:me\s+)?git\s+status\s*$/i,
  /^(?:what(?:'s| has)|what)\s+(?:been\s+)?changed\s*$/i,
  /^changes?\s*$/i,
];

const GIT_DIFF_PATTERNS = [
  /^git\s+diff\s*$/i,
  /^(?:show|display|get)\s+(?:(?:the|me)\s+)*(?:git\s+)?diff(?:\s+for\s+.*)?$/i,
  /^(?:show|display)\s+(?:the\s+)?changes?\s*$/i,
];

const INSPECT_PATTERNS = [
  /(?:inspect|examine|analyze|analyse|review|explore|survey|scan)\s+(?:the\s+)?(?:project|repo|repository|codebase|source|code|workspace|structure|architecture|app)/i,
  /(?:show|tell)\s+(?:me\s+)?(?:the\s+)?(?:project|repo|repository|codebase|source|code|workspace|structure|architecture|app)\s+(?:structure|architecture|layout|setup|organization|folders?|directories)/i,
  /(?:what|which)\s+(?:are\s+)?(?:the\s+)?(?:main|important|key)\s+(?:folders?|directories|files?|modules?|components?)\s*(?:in|of|for)?\s*(?:the\s+)?(?:project|repo|repository|codebase|source|code|workspace|app)?/i,
  /(?:where|what)\s+(?:does|is|are)\s+(?:the\s+)?(?:app|supabase|database|auth|api|entry\s*point|config|routing|layout)\s+(?:live|code|file|setup|config)/i,
  /(?:inspect|show|list)\s+(?:the\s+)?(?:main\s+)?(?:folders?|directories|source\s+directories)/i,
  /(?:where)\s+(?:does|is)\s+[\w.-]+\s+(?:live|code|setup)/i,
  /^(?:inspect|examine|analyze|explore)\s+(?:the\s+)?(?:project|repo|codebase)\s*$/i,
  /^show\s+(?:me\s+)?(?:the\s+)?(?:project|repo|codebase)\s+(?:structure|architecture|layout)\s*$/i,
  /^tell\s+me\s+(?:about|how)\s+(?:the\s+)?(?:project|repo|codebase|app)\s+(?:(?:is\s+)?(?:structured|organized|laid\s+out|set\s+up)|structure|architecture|layout|setup)\s*$/i,
  /^(?:project|repo|codebase)\s+(?:structure|architecture|layout|overview|inspection)\s*$/i,
];

const READINESS_PATTERNS = [
  /(?:is|does)\s+(?:this\s+)?(?:project|app|code|repo|codebase)\s+(?:ready|work|run)\s*(?:locally|locally\?|to\s+run)?/i,
  /(?:can|will)\s+(?:this\s+)?(?:project|app|code|repo|codebase)\s+(?:run|work|start)\s*(?:locally|locally\?|on\s+my\s+machine)?/i,
  /(?:check|verify|test|assess)\s+(?:local\s+)?(?:readiness|setup|prerequisites|dependencies|environment)/i,
  /(?:ready|setup|prerequisites|dependencies)\s+(?:to\s+run|for\s+local|check|status)/i,
  /(?:will|can)\s+it\s+(?:run|work|start)\s*(?:locally|locally\?|on\s+my\s+machine)?/i,
  /^(?:readiness|setup|prerequisites)\s*$/i,
  /(?:check|verify|test|assess)\s+(?:project|app|code|repo|codebase)\s+(?:dependencies|prerequisites|readiness|setup|environment)/i,
];

function normalizePath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (!trimmed || trimmed === "." || trimmed === "./") return undefined;
  return trimmed.replace(/^\.\//, "");
}

function isMutatingIntent(message: string): boolean {
  const lower = message.toLowerCase();
  const mutatingPatterns = [
    /\b(?:fix|edit|change|modify|update|write|create|delete|remove|refactor|build|implement|deploy|commit|push|install|add|remove)\b/i,
  ];
  return mutatingPatterns.some((p) => p.test(lower));
}

export function detectWorkspaceRequest(message: string): WorkspaceRequest {
  const trimmed = message.trim();

  if (isMutatingIntent(trimmed)) {
    return { type: null };
  }

  for (const pattern of INSPECT_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { type: "inspect_project" };
    }
  }

  for (const pattern of READINESS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { type: "check_readiness" };
    }
  }

  for (const pattern of LIST_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { type: "list_files" };
    }
  }

  for (const pattern of GIT_STATUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { type: "git_status" };
    }
  }

  for (const pattern of GIT_DIFF_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { type: "git_diff" };
    }
  }

  for (const pattern of READ_FILE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      const rawPath = match[1]?.trim();
      if (rawPath) {
        return { type: "read_file", path: normalizePath(rawPath) };
      }
    }
  }

  return { type: null };
}
