import { describe, expect, it } from "vitest";
import { COMMAND_CATALOGUE, DEVELOPMENT_COMMAND_TIMEOUT_MS, findDevelopmentCommand, validateCommandRequest } from "@/lib/security/command-catalogue";

const request = (command = "npm test") => ({ command, commandKey: command,
  rules: [{ kind: "exact", value: command }], timeoutMs: DEVELOPMENT_COMMAND_TIMEOUT_MS });

describe("server-owned development command catalogue", () => {
  it.each(["npm run typecheck", "npm run lint", "npm test", "npm run test:unit", "npm run test:integration"])("accepts only the exact catalogue command %s", (command) => {
    const entry = validateCommandRequest(request(command));
    expect(entry).toBe(findDevelopmentCommand(command));
    expect(entry.argv).toEqual(command.split(" "));
    expect(entry).toMatchObject({ workspaceChanged: true, policyAction: "commands.execute" });
  });

  it.each(["npm test; id", "npm test && npm run lint", "npm test $(id)", "npm test `id`", "npm test -- --runInBand",
    "npm test\n", " npm test", "NPM test", "npm run build", "npm install", "git push", "toString", "__proto__", ""])("rejects unknown, expanded or modified command %j", (command) => {
    expect(() => validateCommandRequest(request(command))).toThrow("not permitted");
    expect(findDevelopmentCommand(command)).toBeUndefined();
  });

  it.each([
    { commandKey: "npm run lint" }, { rules: [{ kind: "prefix", value: "npm" }] },
    { rules: [{ kind: "exact", value: "npm run lint" }] }, { rules: [] },
    { rules: [{ kind: "exact", value: "npm test", env: { KEY: "secret" } }] },
    { cwd: "/other-project" }, { args: ["--unsafe"] }, { env: { DATABASE_URL: "secret" } },
    { envOverrides: { NODE_OPTIONS: "--require=unsafe" } }, { approval: true },
    { timeoutMs: 120_000 }, { timeoutMs: 1 }, { timeoutMs: Number.NaN },
  ])("rejects caller authority and overrides %j", (override) => {
    expect(() => validateCommandRequest({ ...request(), ...override })).toThrow("not permitted");
  });

  it("cannot be changed through exported entries, rules or argv", () => {
    const entry = COMMAND_CATALOGUE["npm test"];
    expect(() => Object.assign(COMMAND_CATALOGUE, { "npm test": { command: "id" } })).toThrow();
    expect(() => Object.assign(entry, { command: "id" })).toThrow();
    expect(() => Object.assign(entry.argv, { 0: "sh" })).toThrow();
    expect(() => Object.assign(entry.rules[0], { kind: "prefix" })).toThrow();
  });

  it.each([null, undefined, "npm test", [], {}, { command: "npm test" }])("rejects malformed request %j", (input) => {
    expect(() => validateCommandRequest(input)).toThrow("not permitted");
  });
});
