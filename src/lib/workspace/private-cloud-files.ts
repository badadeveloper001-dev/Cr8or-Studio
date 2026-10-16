import "server-only";

import type { Process } from "@daytona/sdk";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { shellQuote } from "@/lib/workspace/cloud-path";
import { privateRuntimeRelativePath } from "@/lib/workspace/private-runtime-path";

/**
 * Fixed remote filesystem program. No model-generated code, owner/session data,
 * or server environment is sent. Directory descriptors and O_NOFOLLOW prevent
 * ancestor/leaf symlink substitution between validation and the actual I/O.
 * Python 3 and POSIX dir_fd support are required; there is no SDK fallback.
 */
const FILE_PROGRAM = String.raw`
import base64,json,os,stat,sys
fds=[]
try:
    request=json.loads(base64.b64decode(sys.argv[1],validate=True))
    operation=request["operation"]
    relative=request["path"]
    if not isinstance(relative,str) or relative.startswith("/") or "\x00" in relative:
        raise ValueError()
    parts=[part for part in relative.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts) or operation not in ("read","write","list"):
        raise ValueError()
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
    directory=os.open("repo",flags)
    fds.append(directory)
    directories=parts if operation == "list" else parts[:-1]
    for part in directories:
        if operation == "write":
            try: os.mkdir(part,0o700,dir_fd=directory)
            except FileExistsError: pass
        directory=os.open(part,flags,dir_fd=directory)
        fds.append(directory)
    if operation == "list":
        data=[]
        for name in os.listdir(directory):
            if name.startswith("."): continue
            info=os.stat(name,dir_fd=directory,follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode): continue
            data.append({"name":name,"type":"directory" if stat.S_ISDIR(info.st_mode) else "file"})
            if len(data) >= 200: break
    else:
        if not parts: raise ValueError()
        flags=(os.O_RDONLY if operation == "read" else os.O_WRONLY|os.O_CREAT)|os.O_NOFOLLOW|os.O_NONBLOCK
        file=os.open(parts[-1],flags,0o600,dir_fd=directory)
        fds.append(file)
        info=os.fstat(file)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise ValueError()
        if operation == "read":
            with os.fdopen(os.dup(file),"rb") as stream: content=stream.read()
            data={"content":content.decode("utf-8"),"bytes":len(content)}
        else:
            content=request["content"]
            if not isinstance(content,str): raise ValueError()
            encoded=content.encode("utf-8")
            os.ftruncate(file,0)
            with os.fdopen(os.dup(file),"wb") as stream: stream.write(encoded)
            data={"bytes":len(encoded)}
    print(json.dumps({"ok":True,"data":data}))
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

export async function privateCloudFileOperation<Operation extends keyof FileResults>(
  process: Pick<Process, "executeCommand">,
  operation: Operation,
  relativePath: string,
  content?: string,
): Promise<FileResults[Operation]> {
  const relative = privateRuntimeRelativePath(relativePath);
  const payload = Buffer.from(JSON.stringify({ operation, path: relative, ...(operation === "write" ? { content } : {}) }), "utf8").toString("base64");
  try {
    // The SDK cannot cancel an in-flight execution on session revocation. Bound
    // the remote operation itself; the caller revalidates before releasing data.
    const response = await process.executeCommand(`python3 -I -S -c ${shellQuote(FILE_PROGRAM)} ${shellQuote(payload)}`, undefined, undefined, 30);
    if (response.exitCode !== 0) throw new Error();
    const result = JSON.parse(response.artifacts?.stdout ?? response.result) as { ok?: boolean; data?: unknown };
    if (result.ok !== true) throw new Error();
    if (operation === "list") {
      if (!Array.isArray(result.data) || result.data.length > 200 || result.data.some((item) => !item || typeof item.name !== "string" || !["file", "directory"].includes(item.type))) throw new Error();
    } else {
      const value = result.data as Partial<FileResults["read"]> | undefined;
      if (!value || !Number.isSafeInteger(value.bytes) || value.bytes! < 0 || (operation === "read" && typeof value.content !== "string")) throw new Error();
    }
    return result.data as FileResults[Operation];
  } catch {
    throw new ExecutionAuthorizationError(503, "The workspace cannot perform a contained filesystem operation.");
  }
}
