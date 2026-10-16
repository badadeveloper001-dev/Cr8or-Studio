import "server-only";

import type { Process } from "@daytona/sdk";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { shellQuote } from "@/lib/workspace/cloud-path";
import { privateRuntimeRelativePath } from "@/lib/workspace/private-runtime-path";

export const PRIVATE_CLOUD_FILE_LIMITS = Object.freeze({
  writeBytes: 256 * 1024,
  readBytes: 256 * 1024,
  outputBytes: 2 * 1024 * 1024,
  pathBytes: 4096,
  listEntries: 200,
  directoryEntries: 4096,
  remoteSeconds: 30,
  localTimeoutMs: 35_000,
});

function unavailable(): ExecutionAuthorizationError {
  return new ExecutionAuthorizationError(503, "The workspace cannot perform a contained filesystem operation.");
}

function limitExceeded(): ExecutionAuthorizationError {
  return new ExecutionAuthorizationError(409, "The cloud file operation exceeds the supported resource limit.");
}

/**
 * The one-shot SDK API has no stdin. Base64 in argv is not confidential and
 * exceeds OS argument limits for ordinary source files. The separate staged
 * writer lives in private-cloud-write-session; this read/list transport must
 * never become a write fallback. Pathname uploads cannot replace no-follow I/O.
 * Reject before encoding, provider access, or any change to an existing file.
 */
export function rejectPrivateCloudWrite(content: string | undefined): never {
  if (typeof content !== "string") throw unavailable();
  if (content.length > PRIVATE_CLOUD_FILE_LIMITS.writeBytes ||
      Buffer.byteLength(content, "utf8") > PRIVATE_CLOUD_FILE_LIMITS.writeBytes) throw limitExceeded();
  throw new ExecutionAuthorizationError(503, "Private cloud writes require the verified session transport.");
}

/** Fixed read-only program: arguments contain only bounded operation/path metadata. */
const FILE_PROGRAM = String.raw`
import base64,json,os,signal,stat,sys
MAX_READ=${PRIVATE_CLOUD_FILE_LIMITS.readBytes}
MAX_OUTPUT=${PRIVATE_CLOUD_FILE_LIMITS.outputBytes}
MAX_ENTRIES=${PRIVATE_CLOUD_FILE_LIMITS.listEntries}
MAX_SCAN=${PRIVATE_CLOUD_FILE_LIMITS.directoryEntries}
class LimitExceeded(Exception): pass
def deadline(signum,frame): raise TimeoutError()
fds=[]
try:
    signal.signal(signal.SIGALRM,deadline)
    signal.alarm(${PRIVATE_CLOUD_FILE_LIMITS.remoteSeconds})
    request=json.loads(base64.b64decode(sys.argv[1],validate=True))
    operation=request["operation"]
    relative=request["path"]
    if not isinstance(relative,str) or relative.startswith("/") or "\x00" in relative:
        raise ValueError()
    if len(relative.encode("utf-8")) > ${PRIVATE_CLOUD_FILE_LIMITS.pathBytes}: raise LimitExceeded()
    parts=[part for part in relative.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts) or operation not in ("read","list"):
        raise ValueError()
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
    directory=os.open("repo",flags)
    fds.append(directory)
    directories=parts if operation == "list" else parts[:-1]
    for part in directories:
        directory=os.open(part,flags,dir_fd=directory)
        fds.append(directory)
    if operation == "list":
        data=[]
        with os.scandir(directory) as entries:
            for scanned,entry in enumerate(entries,1):
                if scanned > MAX_SCAN: raise LimitExceeded()
                name=entry.name
                if name.startswith("."): continue
                info=entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode): kind="directory"
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1: kind="file"
                else: continue
                data.append({"name":name,"type":kind})
                if len(data) > MAX_ENTRIES: raise LimitExceeded()
    else:
        if not parts: raise ValueError()
        file=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
        fds.append(file)
        info=os.fstat(file)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise ValueError()
        if info.st_size > MAX_READ: raise LimitExceeded()
        with os.fdopen(os.dup(file),"rb") as stream: content=stream.read(MAX_READ+1)
        if len(content) > MAX_READ: raise LimitExceeded()
        data={"content":content.decode("utf-8"),"bytes":len(content)}
    output=json.dumps({"ok":True,"data":data},ensure_ascii=True,separators=(",",":"))
    if len(output.encode("utf-8"))+1 > MAX_OUTPUT: raise LimitExceeded()
    print(output)
except LimitExceeded:
    print('{"ok":false,"error":"LIMIT"}')
    sys.exit(1)
except Exception:
    print('{"ok":false}')
    sys.exit(1)
finally:
    for descriptor in reversed(fds):
        try: os.close(descriptor)
        except OSError: pass
`;

type FileResults = {
  read: { content: string; bytes: number };
  write: { bytes: number };
  list: Array<{ name: string; type: "file" | "directory" }>;
};

async function boundedOperation<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(unavailable()), PRIVATE_CLOUD_FILE_LIMITS.localTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function privateCloudFileOperation<Operation extends keyof FileResults>(
  process: Pick<Process, "executeCommand">,
  operation: Operation,
  relativePath: string,
  content?: string,
): Promise<FileResults[Operation]> {
  if (operation === "write") rejectPrivateCloudWrite(content);
  if (operation !== "read" && operation !== "list") throw unavailable();
  if (typeof relativePath !== "string") throw unavailable();
  if (relativePath.length > PRIVATE_CLOUD_FILE_LIMITS.pathBytes ||
      Buffer.byteLength(relativePath, "utf8") > PRIVATE_CLOUD_FILE_LIMITS.pathBytes) throw limitExceeded();
  try {
    const relative = privateRuntimeRelativePath(relativePath);
    // No content (raw or encoded), session reference, or server environment is sent.
    const payload = Buffer.from(JSON.stringify({ operation, path: relative }), "utf8").toString("base64");
    const response = await boundedOperation(() => process.executeCommand(
      `python3 -I -S -c ${shellQuote(FILE_PROGRAM)} ${shellQuote(payload)}`,
      undefined, undefined, PRIVATE_CLOUD_FILE_LIMITS.remoteSeconds,
    ));
    // The SDK buffers responses before returning them. Bound the trusted helper
    // at the producer and reject excess SDK output before parsing or releasing it.
    for (const value of [response.result, response.artifacts?.stdout]) {
      if (value !== undefined && (typeof value !== "string" ||
          Buffer.byteLength(value, "utf8") > PRIVATE_CLOUD_FILE_LIMITS.outputBytes)) throw limitExceeded();
    }
    const output = response.artifacts?.stdout ?? response.result;
    const result = JSON.parse(output) as { ok?: boolean; error?: unknown; data?: unknown };
    if (result?.ok === false && result.error === "LIMIT") throw limitExceeded();
    if (response.exitCode !== 0 || result?.ok !== true) throw unavailable();
    if (operation === "list") {
      if (!Array.isArray(result.data) || result.data.length > PRIVATE_CLOUD_FILE_LIMITS.listEntries ||
          result.data.some((item) => !item || typeof item.name !== "string" || !item.name ||
            Buffer.byteLength(item.name, "utf8") > 255 || /[/\\\0]/.test(item.name) ||
            item.name === "." || item.name === ".." || !["file", "directory"].includes(item.type))) throw unavailable();
      // Reconstruct the DTO rather than forwarding arbitrary provider properties.
      return result.data.map(({ name, type }) => ({ name, type })) as FileResults[Operation];
    }
    const value = result.data as Partial<FileResults["read"]> | undefined;
    if (!value || typeof value.content !== "string" || !Number.isSafeInteger(value.bytes) || value.bytes! < 0) throw unavailable();
    if (value.bytes! > PRIVATE_CLOUD_FILE_LIMITS.readBytes ||
        Buffer.byteLength(value.content, "utf8") > PRIVATE_CLOUD_FILE_LIMITS.readBytes) throw limitExceeded();
    if (Buffer.byteLength(value.content, "utf8") !== value.bytes ||
        Buffer.from(value.content, "utf8").toString("utf8") !== value.content) throw unavailable();
    return { content: value.content, bytes: value.bytes } as FileResults[Operation];
  } catch (error) {
    // Never attach a provider error, command, stdout, or file contents.
    if (error instanceof ExecutionAuthorizationError && error.status === 409) throw limitExceeded();
    throw unavailable();
  }
}
