#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const MAX_STDIN_BYTES = 16_384;
const MAX_ACCESS_CODE_BYTES = 1_024;
const HELP = `Usage: node --conditions=react-server scripts/manage-owner.mjs <operation> [--stdin]

Operations: provision, rotate, revoke-all, status
provision and rotate require hidden terminal input with confirmation, or --stdin.
--stdin accepts one UTF-8 JSON object with exactly one string property: accessCode.
Access codes must contain at least 16 Unicode code points and at most 1024 UTF-8 bytes.
Whitespace is preserved. Access codes must never be supplied as command arguments.
Set DATABASE_URL in the trusted operator environment. No migrations are performed.
`;

export class OperatorInputError extends Error {
  constructor(message, code = "INVALID_INPUT") {
    super(message);
    this.name = "OperatorInputError";
    this.code = code;
  }
}

function parseArguments(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return { help: true };
  const [operation, option] = argv;
  if (!["provision", "rotate", "revoke-all", "status"].includes(operation) ||
      argv.length > 2 || (option !== undefined && option !== "--stdin") ||
      (option === "--stdin" && !["provision", "rotate"].includes(operation))) {
    throw new OperatorInputError("Invalid arguments. Use --help; never supply an access code as an argument.");
  }
  return { operation, useStdin: option === "--stdin" };
}

/** A byte limit applies before decoding or parsing. Invalid UTF-8 is never replaced silently. */
export async function readAccessCodeFromStdin(input) {
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      length += bytes.length;
      if (length > MAX_STDIN_BYTES) throw new OperatorInputError("Standard input exceeds the input size limit.");
      chunks.push(bytes);
    }
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
    // The restricted grammar rejects duplicate properties as well as extra fields.
    // JSON.parse still validates escapes and returns the exact string value.
    if (!/^\s*\{\s*"accessCode"\s*:\s*"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"\s*\}\s*$/u.test(source)) {
      throw new OperatorInputError("Standard input must be a JSON object containing only the accessCode string.");
    }
    const accessCode = JSON.parse(source).accessCode;
    // JSON escapes can encode lone surrogates even when the source is valid UTF-8.
    // Unicode-mode matching accepts valid pairs without normalizing the string.
    if (/[\uD800-\uDFFF]/u.test(accessCode)) {
      throw new OperatorInputError("Access code must contain valid Unicode.");
    }
    return accessCode;
  } catch (error) {
    if (error instanceof OperatorInputError) throw error;
    throw new OperatorInputError("Standard input must contain valid UTF-8 JSON.");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

/**
 * Raw terminal mode hides every character and is restored on completion, errors, or interruption.
 * @param {import("node:stream").Readable & { isTTY?: boolean, isRaw?: boolean, setRawMode?: (enabled: boolean) => unknown }} input
 * @param {{ write: (text: string) => unknown }} errorOutput
 * @param {string} prompt
 * @param {import("node:events").EventEmitter} signals
 */
export function readHiddenLine(input, errorOutput, prompt, signals = process) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new OperatorInputError("A terminal is required; use --stdin for explicit JSON input."));
  }
  return new Promise((resolveLine, reject) => {
    const wasRaw = Boolean(input.isRaw);
    const wasFlowing = input.readableFlowing;
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let value = "";
    let settled = false;
    const interrupted = () => finish(new OperatorInputError("Operation interrupted.", "INTERRUPTED"));
    const end = () => finish(new OperatorInputError("Terminal input ended before confirmation."));
    const failed = () => finish(new OperatorInputError("Unable to read terminal input."));

    function finish(error) {
      if (settled) return;
      settled = true;
      input.removeListener("data", data);
      input.removeListener("end", end);
      input.removeListener("error", failed);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) signals.removeListener(signal, interrupted);
      try {
        input.setRawMode(wasRaw);
        if (wasFlowing !== true) input.pause();
      } catch {
        error ??= new OperatorInputError("Unable to restore terminal input.");
      }
      errorOutput.write("\n");
      if (error) reject(error);
      else resolveLine(value);
      value = "";
    }

    function data(chunk) {
      try {
        const text = decoder.decode(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), { stream: true });
        for (const character of text) {
          if (["\u0003", "\u0004", "\u001a"].includes(character)) return interrupted();
          if (character === "\r" || character === "\n") {
            decoder.decode(); // Reject an incomplete UTF-8 sequence before accepting input.
            return finish();
          }
          if (character === "\u007f" || character === "\b") {
            value = Array.from(value).slice(0, -1).join("");
          } else if (character < " " || character === "\u001b") {
            return finish(new OperatorInputError("Unsupported terminal input; use --stdin for JSON input."));
          } else {
            value += character;
            if (Buffer.byteLength(value, "utf8") > MAX_ACCESS_CODE_BYTES) {
              return finish(new OperatorInputError("Access code exceeds the UTF-8 byte limit."));
            }
          }
        }
      } catch {
        finish(new OperatorInputError("Terminal input must be valid UTF-8."));
      }
    }

    try {
      input.setRawMode(true);
      errorOutput.write(prompt);
      input.on("data", data);
      input.once("end", end);
      input.once("error", failed);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) signals.once(signal, interrupted);
      input.resume();
    } catch {
      finish(new OperatorInputError("Unable to read terminal input."));
    }
  });
}

async function loadOwnerServices() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const jiti = createJiti(import.meta.url, { alias: {
    "@": resolve(root, "src"),
    // Node resolves this marker using --conditions=react-server; jiti must reuse it.
    "server-only": fileURLToPath(import.meta.resolve("server-only")),
  } });
  const services = await jiti.import(resolve(root, "src/lib/security/owner-management.ts"));
  const { prisma } = await jiti.import(resolve(root, "src/lib/db/prisma.ts"));
  return { ...services, close: () => prisma.$disconnect() };
}

function safeFailure(error) {
  if (error instanceof OperatorInputError) return { code: error.code, message: error.message };
  const messages = {
    ALREADY_PROVISIONED: "The owner is already provisioned. Use rotate to change the access code.",
    OWNER_NOT_PROVISIONED: "The owner credential has not been provisioned.",
  };
  if (Object.hasOwn(messages, error?.code)) return { code: error.code, message: messages[error.code] };
  return { code: "UNAVAILABLE", message: "The owner operation could not be completed. Check the trusted configuration and database availability." };
}

function publicResult(operation, result) {
  if (operation === "revoke-all") return { credentialVersion: result.credentialVersion, revokedCount: result.revokedCount };
  const metadata = {
    credentialVersion: result.credentialVersion, createdAt: result.createdAt, updatedAt: result.updatedAt,
  };
  if (operation === "status") return {
    provisioned: result.provisioned, ...metadata,
    sessions: {
      total: result.sessions.total, active: result.sessions.active,
      revoked: result.sessions.revoked, expired: result.sessions.expired,
    },
  };
  return operation === "rotate" ? { ...metadata, revokedCount: result.revokedCount } : metadata;
}

/** Dependency injection keeps unit tests away from real owner records and credentials. */
export async function main({
  argv = process.argv.slice(2), input = process.stdin, output = process.stdout,
  errorOutput = process.stderr, env = process.env, loadServices = loadOwnerServices,
} = {}) {
  let services;
  let response;
  let exitCode = 0;
  try {
    const { operation, useStdin, help } = parseArguments(argv);
    if (help) {
      output.write(HELP);
      return 0;
    }
    if (typeof env.DATABASE_URL !== "string" || env.DATABASE_URL.length === 0) {
      throw new OperatorInputError("Set DATABASE_URL in the trusted operator environment.", "CONFIGURATION_REQUIRED");
    }
    let accessCode;
    if (["provision", "rotate"].includes(operation)) {
      if (useStdin) accessCode = await readAccessCodeFromStdin(input);
      else {
        accessCode = await readHiddenLine(input, errorOutput, "Access code (hidden): ");
        const confirmation = await readHiddenLine(input, errorOutput, "Confirm access code (hidden): ");
        if (accessCode !== confirmation) throw new OperatorInputError("Access code confirmation did not match.");
      }
      if (Array.from(accessCode).length < 16 || Buffer.byteLength(accessCode, "utf8") > MAX_ACCESS_CODE_BYTES) {
        throw new OperatorInputError("Access code must contain at least 16 Unicode code points and at most 1024 UTF-8 bytes.");
      }
    }
    services = await loadServices();
    let result;
    if (operation === "provision") result = await services.provisionOwner(accessCode);
    else if (operation === "rotate") result = await services.rotateOwnerAccessCode(accessCode);
    else if (operation === "revoke-all") result = await services.revokeAllOwnerSessions();
    else result = await services.inspectOwnerStatus();
    response = { ok: true, operation, ...publicResult(operation, result) };
  } catch (error) {
    response = { ok: false, error: safeFailure(error) };
    exitCode = error instanceof OperatorInputError ? 2 : 1;
  } finally {
    try {
      await services?.close?.();
    } catch {
      // The mutation may have committed. Do not imply rollback or expose cleanup errors.
    }
  }
  output.write(`${JSON.stringify(response)}\n`);
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
