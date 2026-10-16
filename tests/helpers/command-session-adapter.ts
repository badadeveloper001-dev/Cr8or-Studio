import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import { PRIVATE_CLOUD_COMMAND_PROGRAM } from "@/lib/workspace/private-cloud-command-program";
import { shellQuote } from "@/lib/workspace/cloud-path";
import { createControlledDaytonaSessionAdapter } from "./daytona-session-adapter";

type FixtureOptions = NonNullable<Parameters<typeof createControlledDaytonaSessionAdapter>[1]> & {
  commandSeconds?: number;
};

/**
 * Actual local npm execution using the real fixed supervisor and disposable
 * repository. Only immutable deployment paths / UID checks are adapted to the
 * Codex test installation. This is explicitly not proof of a Daytona image's
 * root ownership, process identity, session behavior, or network isolation.
 */
export function createControlledCommandSessionAdapter(root: string, options: FixtureOptions = {}) {
  const node = realpathSync(process.execPath);
  const nodeDirectory = path.dirname(node);
  const npm = realpathSync(path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"));
  const trustedOwners = new Set([0, statSync(node).uid]);
  const installation = `${path.dirname(nodeDirectory)}/`;
  const program = PRIVATE_CLOUD_COMMAND_PROGRAM
    .replace('ROOT="/workspace"', `ROOT=${JSON.stringify(root)}`)
    .replace("REQUIRE_UNPRIVILEGED=True", `REQUIRE_UNPRIVILEGED=${process.getuid?.() === 0 ? "False" : "True"}`)
    .replace('NODE_CANDIDATES=("/usr/local/bin/node","/usr/bin/node")', `NODE_CANDIDATES=(${JSON.stringify(node)},)`)
    .replace('NPM_CANDIDATES=("/usr/local/bin/npm","/usr/bin/npm")', `NPM_CANDIDATES=(${JSON.stringify(npm)},)`)
    .replace('INSTALL_ROOTS=("/usr/local/","/usr/")', `INSTALL_ROOTS=(${JSON.stringify(installation)},)`)
    .replace("TRUSTED_OWNER_UIDS=(0,)", `TRUSTED_OWNER_UIDS=(${[...trustedOwners].join(",")},)`)
    .replace('"PATH":"/usr/local/bin:/usr/bin:/bin"', `"PATH":${JSON.stringify(`${nodeDirectory}:/usr/bin:/bin`)}`)
    // The disposable fixture shares Codex's UID with other test processes; this
    // adaptation is not evidence for the production per-UID process ceiling.
    .replace("MAX_PROCESSES=64", "MAX_PROCESSES=512")
    .replace("MAX_SECONDS=60", `MAX_SECONDS=${options.commandSeconds ?? 60}`);
  const adapter = createControlledDaytonaSessionAdapter(root, options);
  const originalExecute = adapter.executeSessionCommand;
  const submittedCommands: string[] = [];
  adapter.executeSessionCommand = async (sessionId, request, timeout) => {
    submittedCommands.push(request.command);
    if (!request.command.includes(shellQuote(PRIVATE_CLOUD_COMMAND_PROGRAM))) {
      throw new Error("The local command fixture accepts only the fixed supervisor.");
    }
    return originalExecute(sessionId, { ...request,
      command: request.command.replace(shellQuote(PRIVATE_CLOUD_COMMAND_PROGRAM), shellQuote(program)),
    }, timeout);
  };
  return { ...adapter, submittedCommands };
}

export type ControlledCommandSessionAdapter = ReturnType<typeof createControlledCommandSessionAdapter>;
