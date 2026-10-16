import "server-only";

import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import type { SandboxCommandRule } from "@/lib/security/sandbox";

export const DEVELOPMENT_COMMAND_TIMEOUT_MS = 60_000;

export type CommandCatalogueEntry = Readonly<{
  key: string;
  command: string;
  argv: readonly string[];
  rules: readonly SandboxCommandRule[];
  policyAction: "commands.execute";
  workspaceChanged: true;
  description: string;
}>;

function entry(command: string, argv: readonly string[], description: string): CommandCatalogueEntry {
  return Object.freeze({ key: command, command, argv: Object.freeze([...argv]),
    rules: Object.freeze([Object.freeze({ kind: "exact" as const, value: command })]),
    policyAction: "commands.execute", workspaceChanged: true, description });
}

/** Npm scripts execute project code and may modify files, even lint and typecheck. */
export const COMMAND_CATALOGUE: Readonly<Record<string, CommandCatalogueEntry>> = Object.freeze({
  "npm run typecheck": entry("npm run typecheck", ["npm", "run", "typecheck"], "Run TypeScript type checking"),
  "npm run lint": entry("npm run lint", ["npm", "run", "lint"], "Run ESLint"),
  "npm test": entry("npm test", ["npm", "test"], "Run all tests"),
  "npm run test:unit": entry("npm run test:unit", ["npm", "run", "test:unit"], "Run unit tests"),
  "npm run test:integration": entry("npm run test:integration", ["npm", "run", "test:integration"], "Run integration tests"),
});

export function findDevelopmentCommand(command: unknown): CommandCatalogueEntry | undefined {
  return typeof command === "string" && Object.hasOwn(COMMAND_CATALOGUE, command) ? COMMAND_CATALOGUE[command] : undefined;
}

const REQUEST_KEYS = new Set(["command", "commandKey", "rules", "timeoutMs", "commandAuthorization"]);

/** Rules supplied by a caller are checked for compatibility, never used as policy. */
export function validateCommandRequest(request: unknown): CommandCatalogueEntry {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      Reflect.ownKeys(request).some((key) => typeof key !== "string" || !REQUEST_KEYS.has(key))) {
    throw new ExecutionAuthorizationError(403, "Command request is not permitted.");
  }
  const input = request as Record<string, unknown>;
  const command = findDevelopmentCommand(input.command);
  const rules = input.rules;
  if (!command || input.commandKey !== command.key ||
      (input.timeoutMs !== undefined && input.timeoutMs !== DEVELOPMENT_COMMAND_TIMEOUT_MS) ||
      !Array.isArray(rules) || rules.length !== 1 || !rules[0] || typeof rules[0] !== "object" ||
      Reflect.ownKeys(rules[0]).some((key) => key !== "kind" && key !== "value") ||
      rules[0].kind !== "exact" || rules[0].value !== command.command) {
    throw new ExecutionAuthorizationError(403, "Command request is not permitted.");
  }
  return command;
}
