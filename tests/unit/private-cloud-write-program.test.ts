import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PRIVATE_CLOUD_WRITE_PROGRAM } from "@/lib/workspace/private-cloud-write-program";

const nonce = "0123456789abcdef0123456789abcdef";
const prefix = `#CR8OR-WRITE/1 ${nonce} `;
const outputPrefix = `CR8OR-WRITE/1 ${nonce} `;
const children: ChildProcessWithoutNullStreams[] = [];
let root: string;

function hash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function transfer(content: Buffer): string {
  let framed = `${prefix}BEGIN ${content.length} ${hash(content)}\n`;
  for (let offset = 0, sequence = 0; offset < content.length; offset += 12_288, sequence++) {
    framed += `${prefix}DATA ${sequence} ${content.subarray(offset, offset + 12_288).toString("base64")}\n`;
  }
  return `${framed}${prefix}END\n`;
}

function start(target = "file.txt", program = PRIVATE_CLOUD_WRITE_PROGRAM) {
  const metadata = Buffer.from(JSON.stringify({ path: target, nonce })).toString("base64");
  const child = spawn("python3", ["-I", "-S", "-u", "-c", program, metadata], { cwd: root });
  children.push(child);
  // Rejected transfers may close stdin before a test's final synthetic frame.
  child.stdin.on("error", () => {});
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data.toString("utf8"); });
  child.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
  const completed = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  async function waitFor(message: string): Promise<void> {
    const expected = `${outputPrefix}${message}\n`;
    if (stdout.includes(expected)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("Helper did not reach the expected state.")); }, 3_000);
      const check = () => { if (stdout.includes(expected)) { cleanup(); resolve(); } };
      const closed = () => { cleanup(); reject(new Error("Helper closed before the expected state.")); };
      function cleanup() {
        clearTimeout(timer);
        child.stdout.removeListener("data", check);
        child.removeListener("close", closed);
      }
      child.stdout.on("data", check);
      child.once("close", closed);
      check();
    });
  }
  return { child, completed, waitFor };
}

async function expectRejected(operation: ReturnType<typeof start>) {
  const result = await operation.completed;
  expect(result.code).toBe(1);
  expect(result.stdout.split("\n").filter(Boolean)).toEqual(expect.arrayContaining([`${outputPrefix}ERROR`]));
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain("COMMITTED");
  return result;
}

async function stage(content = Buffer.from("replacement"), target = "file.txt") {
  const operation = start(target);
  await operation.waitFor("READY");
  operation.child.stdin.write(transfer(content));
  await operation.waitFor(`STAGED ${content.length}`);
  return operation;
}

async function files(directory = path.join(root, "repo")): Promise<string[]> {
  return fs.readdir(directory);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "cr8or-cloud-write-"));
  await fs.mkdir(path.join(root, "repo"));
  await fs.mkdir(path.join(root, "outside"));
  await fs.writeFile(path.join(root, "outside", "secret.txt"), "outside secret");
});

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGKILL");
      await closed;
    }
  }));
  await fs.rm(root, { recursive: true, force: true });
});

describe("actual staged Python cloud writer", () => {
  it.each(["", "plain source", "🌍\r\n\t\0e\u0301\n", "$(touch injected); `touch injected` ' \"\n"])("preserves exact UTF-8 content (%j)", async (content) => {
    const operation = await stage(Buffer.from(content));
    await expect(fs.stat(path.join(root, "repo", "file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    operation.child.stdin.end(`${prefix}COMMIT\n`);
    const result = await operation.completed;
    expect(result).toEqual({ code: 0, stdout: `${outputPrefix}READY\n${outputPrefix}STAGED ${Buffer.byteLength(content)}\n${outputPrefix}COMMITTED ${Buffer.byteLength(content)}\n`, stderr: "" });
    expect(await fs.readFile(path.join(root, "repo", "file.txt"))).toEqual(Buffer.from(content));
    expect((await fs.stat(path.join(root, "repo", "file.txt"))).mode & 0o777).toBe(0o600);
    expect(await files()).toEqual(["file.txt"]);
    await expect(fs.stat(path.join(root, "injected"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates missing directories through contained descriptors", async () => {
    const operation = await stage(Buffer.from("nested"), "one/two/file.txt");
    operation.child.stdin.end(`${prefix}COMMIT\n`);
    expect((await operation.completed).code).toBe(0);
    expect(await fs.readFile(path.join(root, "repo", "one", "two", "file.txt"), "utf8")).toBe("nested");
  });

  it("stages privately and atomically replaces a complete existing executable file", async () => {
    const target = path.join(root, "repo", "file.txt");
    await fs.writeFile(target, "original", { mode: 0o6755 });
    await fs.chmod(target, 0o6755);
    const original = await fs.stat(target);
    const operation = await stage();
    expect(await fs.readFile(target, "utf8")).toBe("original");
    const stageName = (await files()).find((name) => name.startsWith(".cr8or-write-"))!;
    expect((await fs.stat(path.join(root, "repo", stageName))).mode & 0o7777).toBe(0o600);
    operation.child.stdin.end(`${prefix}COMMIT\n`);
    expect((await operation.completed).code).toBe(0);
    const replacement = await fs.stat(target);
    expect(replacement.ino).not.toBe(original.ino);
    expect(replacement.mode & 0o7777).toBe(0o755);
    expect(await fs.readFile(target, "utf8")).toBe("replacement");
    expect(await files()).toEqual(["file.txt"]);
  });

  it("handles the 256 KiB boundary, including split multibyte UTF-8 sequences", async () => {
    const content = Buffer.from("a" + "🌍".repeat(65_535) + "xyz");
    expect(content.length).toBe(262_144);
    const operation = await stage(content);
    operation.child.stdin.end(`${prefix}COMMIT\n`);
    expect((await operation.completed).code).toBe(0);
    expect(await fs.readFile(path.join(root, "repo", "file.txt"))).toEqual(content);
  });

  it("disables real terminal echo, canonical input limits, and newline conversion before READY", async () => {
    // This exercises a local PTY, not a live Daytona session. All source frames
    // still travel through stdin; only the fixed helper and path enter argv.
    const harness = String.raw`
import base64,json,os,pty,select,subprocess,sys,time
request=json.load(sys.stdin)
master,slave=pty.openpty()
child=subprocess.Popen(["python3","-I","-S","-u","-c",base64.b64decode(sys.argv[1]).decode("utf-8"),sys.argv[2]],stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
output=b""
def wait_for(marker):
    global output
    deadline=time.monotonic()+3
    while marker not in output:
        remaining=deadline-time.monotonic()
        if remaining<=0 or not select.select([master],[],[],remaining)[0]: raise TimeoutError()
        chunk=os.read(master,4096)
        if not chunk: raise EOFError()
        output+=chunk
        if len(output)>4096: raise ValueError()
def send(value):
    pending=value.encode("ascii")
    while pending:
        written=os.write(master,pending)
        if written<=0: raise EOFError()
        pending=pending[written:]
try:
    wait_for(b" READY\n")
    send(request["transfer"])
    wait_for(b" STAGED "+str(request["bytes"]).encode("ascii")+b"\n")
    send(request["commit"])
    wait_for(b" COMMITTED "+str(request["bytes"]).encode("ascii")+b"\n")
    code=child.wait(timeout=3)
    print(json.dumps({"code":code,"output":output.decode("ascii")}))
finally:
    os.close(master)
    if child.poll() is None:
        child.kill()
        child.wait()
`;
    const content = Buffer.from("\r\n🌍".repeat(3_000));
    const metadata = Buffer.from(JSON.stringify({ path: "file.txt", nonce })).toString("base64");
    const child = spawn("python3", ["-I", "-S", "-u", "-c", harness, Buffer.from(PRIVATE_CLOUD_WRITE_PROGRAM).toString("base64"), metadata], { cwd: root });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    const completed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin.end(JSON.stringify({ transfer: transfer(content), bytes: content.length, commit: `${prefix}COMMIT\n` }));
    expect(await completed).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ code: 0, output: `${outputPrefix}READY\n${outputPrefix}STAGED ${content.length}\n${outputPrefix}COMMITTED ${content.length}\n` });
    expect(await fs.readFile(path.join(root, "repo", "file.txt"))).toEqual(content);
  });

  it.each(["ABORT", "disconnect", "SIGTERM", "SIGHUP", "SIGALRM"])("preserves the destination and cleans stages on %s", async (failure) => {
    await fs.writeFile(path.join(root, "repo", "file.txt"), "original");
    const operation = await stage();
    if (failure === "ABORT") operation.child.stdin.end(`${prefix}ABORT\n`);
    else if (failure === "disconnect") operation.child.stdin.end();
    else operation.child.kill(failure as NodeJS.Signals);
    await expectRejected(operation);
    expect(await fs.readFile(path.join(root, "repo", "file.txt"), "utf8")).toBe("original");
    expect(await files()).toEqual(["file.txt"]);
  });

  it("removes only its empty newly created directories when a transfer aborts", async () => {
    const operation = await stage(Buffer.from("nested"), "one/two/file.txt");
    operation.child.stdin.end(`${prefix}ABORT\n`);
    await expectRejected(operation);
    expect(await files()).toEqual([]);
  });

  it("finishes cleanup when session deletion signals arrive during ABORT cleanup", async () => {
    // Deliver actual pending signals at the critical cleanup point, after the
    // helper has entered finally; neither may interrupt removal of the stage.
    const program = PRIVATE_CLOUD_WRITE_PROGRAM.replace("signal.alarm(0)", "signal.alarm(0)\n    signal.raise_signal(signal.SIGTERM)\n    signal.raise_signal(signal.SIGHUP)");
    await fs.writeFile(path.join(root, "repo", "file.txt"), "original");
    const operation = start("file.txt", program);
    await operation.waitFor("READY");
    operation.child.stdin.write(transfer(Buffer.from("replacement")));
    await operation.waitFor("STAGED 11");
    operation.child.stdin.end(`${prefix}ABORT\n`);
    await expectRejected(operation);
    expect(await fs.readFile(path.join(root, "repo", "file.txt"), "utf8")).toBe("original");
    expect(await files()).toEqual(["file.txt"]);
  });

  it("does not interrupt ABORT unwinding when TERM arrives before the finally signal mask", async () => {
    const program = PRIVATE_CLOUD_WRITE_PROGRAM.replace("    # Session deletion may", "    signal.raise_signal(signal.SIGTERM)\n    signal.raise_signal(signal.SIGHUP)\n    # Session deletion may");
    await fs.writeFile(path.join(root, "repo", "file.txt"), "original");
    const operation = start("file.txt", program);
    await operation.waitFor("READY");
    operation.child.stdin.write(transfer(Buffer.from("replacement")));
    await operation.waitFor("STAGED 11");
    operation.child.stdin.end(`${prefix}ABORT\n`);
    await expectRejected(operation);
    expect(await fs.readFile(path.join(root, "repo", "file.txt"), "utf8")).toBe("original");
    expect(await files()).toEqual(["file.txt"]);
  });

  it("does not lose cancellation recorded during a handled destination lookup exception", async () => {
    const program = PRIVATE_CLOUD_WRITE_PROGRAM.replace("    except FileNotFoundError:\n        return None", "    except FileNotFoundError:\n        signal.raise_signal(signal.SIGTERM)\n        return None");
    const operation = start("file.txt", program);
    await expectRejected(operation);
    expect(await files()).toEqual([]);
  });

  it.each(["stage", "directory"])("tracks a new %s before handling cancellation", async (resource) => {
    const program = resource === "stage"
      ? PRIVATE_CLOUD_WRITE_PROGRAM.replace("        fds.append(stage)", "        signal.raise_signal(signal.SIGTERM)\n        fds.append(stage)")
      : PRIVATE_CLOUD_WRITE_PROGRAM.replace("                    made=True", "                    signal.raise_signal(signal.SIGHUP)\n                    made=True");
    await fs.writeFile(path.join(root, "repo", "file.txt"), "original");
    const operation = start(resource === "stage" ? "file.txt" : "nested/file.txt", program);
    if (resource === "stage") {
      await operation.waitFor("READY");
      operation.child.stdin.end(transfer(Buffer.from("replacement")));
    }
    await expectRejected(operation);
    expect(await fs.readFile(path.join(root, "repo", "file.txt"), "utf8")).toBe("original");
    expect(await files()).toEqual(["file.txt"]);
  });

  it("uses the same cleanup path when the real remote alarm expires", async () => {
    // Shorten only the fixed timer for a practical actual-process deadline test.
    const program = PRIVATE_CLOUD_WRITE_PROGRAM.replace("signal.alarm(30)", "signal.alarm(1)");
    await fs.writeFile(path.join(root, "repo", "file.txt"), "original");
    const operation = start("file.txt", program);
    await operation.waitFor("READY");
    operation.child.stdin.write(transfer(Buffer.from("replacement")));
    await operation.waitFor("STAGED 11");
    await expectRejected(operation);
    expect(await fs.readFile(path.join(root, "repo", "file.txt"), "utf8")).toBe("original");
    expect(await files()).toEqual(["file.txt"]);
  });

  it.each([
    { name: "incomplete content", input: `${prefix}BEGIN 10 ${hash(Buffer.from("1234567890"))}\n${prefix}DATA 0 MTIz\n` },
    { name: "missing END", input: transfer(Buffer.from("1234")).replace(`${prefix}END\n`, "") },
    { name: "wrong digest", input: transfer(Buffer.from("1234")).replace(hash(Buffer.from("1234")), "0".repeat(64)) },
    { name: "invalid UTF-8", input: transfer(Buffer.from([0xc3, 0x28])) },
    { name: "incomplete UTF-8", input: transfer(Buffer.from([0xe2, 0x82])) },
    { name: "oversized declaration", input: `${prefix}BEGIN 262145 ${"0".repeat(64)}\n` },
    { name: "oversized line", input: `${prefix}${"x".repeat(16_513)}\n` },
    { name: "wrong sequence", input: transfer(Buffer.from("1234")).replace("DATA 0", "DATA 1") },
    { name: "leading-zero count", input: transfer(Buffer.from("1234")).replace("BEGIN 4", "BEGIN 04") },
    { name: "extra BEGIN field", input: transfer(Buffer.from("1234")).replace("\n", " extra\n") },
    { name: "trailing DATA field", input: transfer(Buffer.from("1234")).replace("MTIzNA==", "MTIzNA== extra") },
    { name: "invalid Base64", input: transfer(Buffer.from("1234")).replace("MTIzNA==", "MTIzNA!!") },
    { name: "noncanonical Base64", input: transfer(Buffer.from("1234")).replace("MTIzNA==", "MTIzNB==") },
    { name: "mismatched nonce", input: transfer(Buffer.from("1234")).replace(nonce, "a".repeat(32)) },
    { name: "unframed content", input: "content\n" },
    { name: "unexpected COMMIT", input: `${prefix}COMMIT\n` },
    { name: "carriage return framing", input: transfer(Buffer.from("1234")).replaceAll("\n", "\r\n") },
    { name: "extra data", input: transfer(Buffer.from("1234")).replace(`${prefix}END`, `${prefix}DATA 1 eA==\n${prefix}END`) },
  ])("rejects $name without corrupting the file or leaking contents", async ({ input }) => {
    await fs.writeFile(path.join(root, "repo", "file.txt"), "original");
    const operation = start();
    await operation.waitFor("READY");
    operation.child.stdin.end(input);
    const result = await expectRejected(operation);
    expect(result.stdout).toBe(`${outputPrefix}READY\n${outputPrefix}ERROR\n`);
    expect(await fs.readFile(path.join(root, "repo", "file.txt"), "utf8")).toBe("original");
    expect(await files()).toEqual(["file.txt"]);
  });

  it.each(["root", "ancestor", "destination"])("rejects %s symlinks without modifying outside files", async (kind) => {
    let target = "linked/secret.txt";
    if (kind === "root") {
      await fs.rm(path.join(root, "repo"), { recursive: true });
      await fs.symlink(path.join(root, "outside"), path.join(root, "repo"));
      target = "secret.txt";
    } else if (kind === "ancestor") {
      await fs.symlink(path.join(root, "outside"), path.join(root, "repo", "linked"));
    } else {
      target = "file.txt";
      await fs.symlink(path.join(root, "outside", "secret.txt"), path.join(root, "repo", target));
    }
    await expectRejected(start(target));
    expect(await fs.readFile(path.join(root, "outside", "secret.txt"), "utf8")).toBe("outside secret");
  });

  it("rejects a hard-linked destination", async () => {
    await fs.link(path.join(root, "outside", "secret.txt"), path.join(root, "repo", "file.txt"));
    await expectRejected(start());
    expect(await fs.readFile(path.join(root, "outside", "secret.txt"), "utf8")).toBe("outside secret");
  });

  it.each(["directory", "fifo"])("rejects a %s destination without blocking", async (kind) => {
    if (kind === "directory") await fs.mkdir(path.join(root, "repo", "file.txt"));
    else {
      const child = spawn("mkfifo", [path.join(root, "repo", "file.txt")]);
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Fixture creation failed.")));
      });
    }
    await expectRejected(start());
  });

  it.each(["../outside/secret.txt", "/etc/passwd", "a/../../file", "a\\file", "C:foo", "a//b", "a/./b", ".git/config", "nested/.env.production", "secrets/file", "CREDENTIALS", "key.pem", "file.KEY", ".npmrc", "id_rsa", "id_ed25519", "\0", "a".repeat(4097)])("rejects an unsafe or oversized path (%s)", async (target) => {
    await expectRejected(start(target));
    expect(await files()).toEqual([]);
    expect(await fs.readFile(path.join(root, "outside", "secret.txt"), "utf8")).toBe("outside secret");
  });

  it("allows a non-sensitive environment example", async () => {
    const operation = await stage(Buffer.from("EXAMPLE=none\n"), ".env.example");
    operation.child.stdin.end(`${prefix}COMMIT\n`);
    expect((await operation.completed).code).toBe(0);
    expect(await fs.readFile(path.join(root, "repo", ".env.example"), "utf8")).toBe("EXAMPLE=none\n");
  });

  it.each(["replace", "modify", "hardlink", "symlink"])("rejects destination %s between staging and commit", async (attack) => {
    const target = path.join(root, "repo", "file.txt");
    await fs.writeFile(target, "original");
    const operation = await stage();
    if (attack === "replace") {
      await fs.rename(target, path.join(root, "repo", "old.txt"));
      await fs.writeFile(target, "new concurrent file");
    } else if (attack === "modify") await fs.writeFile(target, "concurrent edit");
    else if (attack === "hardlink") await fs.link(target, path.join(root, "repo", "linked.txt"));
    else {
      await fs.unlink(target);
      await fs.symlink(path.join(root, "outside", "secret.txt"), target);
    }
    operation.child.stdin.end(`${prefix}COMMIT\n`);
    await expectRejected(operation);
    expect((await files()).some((name) => name.startsWith(".cr8or-write-"))).toBe(false);
    expect(await fs.readFile(path.join(root, "outside", "secret.txt"), "utf8")).toBe("outside secret");
    if (attack === "replace") expect(await fs.readFile(target, "utf8")).toBe("new concurrent file");
    if (attack === "modify") expect(await fs.readFile(target, "utf8")).toBe("concurrent edit");
    if (attack === "hardlink") expect(await fs.readFile(target, "utf8")).toBe("original");
  });

  it("rejects a destination that appeared after staging began", async () => {
    const operation = await stage();
    await fs.writeFile(path.join(root, "repo", "file.txt"), "concurrent creation");
    operation.child.stdin.end(`${prefix}COMMIT\n`);
    await expectRejected(operation);
    expect(await fs.readFile(path.join(root, "repo", "file.txt"), "utf8")).toBe("concurrent creation");
  });

  it.each(["root", "ancestor"])("rejects a renamed %s before commit and cleans the original stage", async (kind) => {
    await fs.mkdir(path.join(root, "repo", "nested"));
    await fs.writeFile(path.join(root, "repo", "nested", "file.txt"), "original");
    const operation = await stage(Buffer.from("replacement"), "nested/file.txt");
    const before = kind === "root" ? path.join(root, "repo") : path.join(root, "repo", "nested");
    const renamed = path.join(root, "moved");
    await fs.rename(before, renamed);
    await fs.mkdir(before);
    operation.child.stdin.end(`${prefix}COMMIT\n`);
    await expectRejected(operation);
    const oldParent = kind === "root" ? path.join(renamed, "nested") : renamed;
    expect(await fs.readFile(path.join(oldParent, "file.txt"), "utf8")).toBe("original");
    expect(await files(oldParent)).toEqual(["file.txt"]);
  });

  it.each(["symlink", "hardlink", "replacement", "modified bytes"])("rejects a staged-file %s attack before replacement", async (attack) => {
    await fs.writeFile(path.join(root, "repo", "file.txt"), "original");
    const operation = await stage();
    const stageName = (await files()).find((name) => name.startsWith(".cr8or-write-"))!;
    const stagePath = path.join(root, "repo", stageName);
    if (attack === "hardlink") await fs.link(stagePath, path.join(root, "repo", "linked-stage"));
    else if (attack === "modified bytes") await fs.writeFile(stagePath, "evil source");
    else {
      await fs.unlink(stagePath);
      if (attack === "symlink") await fs.symlink(path.join(root, "outside", "secret.txt"), stagePath);
      else await fs.writeFile(stagePath, "different stage");
    }
    operation.child.stdin.end(`${prefix}COMMIT\n`);
    await expectRejected(operation);
    expect(await fs.readFile(path.join(root, "repo", "file.txt"), "utf8")).toBe("original");
    expect(await fs.readFile(path.join(root, "outside", "secret.txt"), "utf8")).toBe("outside secret");
  });

  it("preserves the old destination when atomic replacement itself fails", async () => {
    // Inject only a failing syscall; staging/transfer/validation/cleanup use the real filesystem.
    const program = PRIVATE_CLOUD_WRITE_PROGRAM.replace("os.replace(stage_name,parts[-1],src_dir_fd=directory,dst_dir_fd=directory)", "raise OSError('synthetic replacement failure')");
    await fs.writeFile(path.join(root, "repo", "file.txt"), "original");
    const operation = start("file.txt", program);
    await operation.waitFor("READY");
    operation.child.stdin.write(transfer(Buffer.from("replacement")));
    await operation.waitFor("STAGED 11");
    operation.child.stdin.end(`${prefix}COMMIT\n`);
    await expectRejected(operation);
    expect(await fs.readFile(path.join(root, "repo", "file.txt"), "utf8")).toBe("original");
    expect(await files()).toEqual(["file.txt"]);
  });

  it("does not falsely acknowledge a post-replacement durability failure", async () => {
    // The transport must treat any failure after sending COMMIT as ambiguous.
    const program = PRIVATE_CLOUD_WRITE_PROGRAM.replace("os.fsync(directory)", "raise OSError('synthetic durability failure')");
    const operation = start("file.txt", program);
    await operation.waitFor("READY");
    operation.child.stdin.write(transfer(Buffer.from("replacement")));
    await operation.waitFor("STAGED 11");
    operation.child.stdin.end(`${prefix}COMMIT\n`);
    await expectRejected(operation);
    expect(await fs.readFile(path.join(root, "repo", "file.txt"), "utf8")).toBe("replacement");
    expect(await files()).toEqual(["file.txt"]);
  });
});
