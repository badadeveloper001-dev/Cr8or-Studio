import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { shellQuote } from "@/lib/workspace/cloud-path";
import { PRIVATE_REPOSITORY_PROGRAM } from "@/lib/workspace/private-repository-program";
import { privateRepositorySession, type RepositoryInitializationMetadata } from "@/lib/workspace/private-repository-session";
import { createControlledDaytonaSessionAdapter } from "../helpers/daytona-session-adapter";

type Graph = { version: 1; repositoryKey: string; branch: string; head: string; objects: {oid: string; type: "blob"|"tree"|"commit"; contentBase64: string}[] };
let root: string, adapter: ReturnType<typeof createControlledDaytonaSessionAdapter>;
let graph: Graph, metadata: RepositoryInitializationMetadata, program: string;
function fixture(): Graph {
  const objects: Graph["objects"] = [];
  function object(type: Graph["objects"][number]["type"], body: Buffer | string) {
    const bytes = Buffer.from(body);
    const oid = createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
    objects.push({ oid, type, contentBase64: bytes.toString("base64") });
    return oid;
  }
  const blob = object("blob", "const unicode = '你好 🌍';\n");
  const tree = object("tree", Buffer.concat([Buffer.from("100644 source.ts\0"),Buffer.from(blob,"hex")]));
  const head = object("commit", `tree ${tree}\nauthor Synthetic owner <owner@example.invalid> 1700000000 +0000\ncommitter Synthetic owner <owner@example.invalid> 1700000000 +0000\n\nInitial synthetic history\n`);
  return { version: 1, repositoryKey: "badadeveloper001-dev/cr8or-studio", branch: "main", head, objects };
}
function configure(options: Parameters<typeof createControlledDaytonaSessionAdapter>[1] = {}) {
  adapter = createControlledDaytonaSessionAdapter(root, options);
  const execute = adapter.executeSessionCommand;
  adapter.executeSessionCommand = async (session, request, timeout) => {
    expect(request.command).toBe(`exec python3 -I -S -u -c ${shellQuote(PRIVATE_REPOSITORY_PROGRAM)}`);
    return execute(session, { ...request, command: `exec python3 -I -S -u -c ${shellQuote(program)}` }, timeout);
  };
}
const run = (mode: "initialize" | "inspect" = "initialize", revalidate = async () => undefined, signal = new AbortController().signal) =>
  privateRepositorySession(adapter, metadata, graph, revalidate, signal, mode);
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(),"cr8or-repository-helper-"));
  graph = fixture();
  metadata = { operationId:"synthetic-clone-operation", projectId:"synthetic-clone-project", workspaceRecordId:"synthetic-clone-registration", providerWorkspaceId:"synthetic-clone-sandbox", repositoryKey:graph.repositoryKey, branch:graph.branch, head:graph.head };
  const owners = new Set([0,(await fs.stat("/usr/bin/git")).uid]);
  program = PRIVATE_REPOSITORY_PROGRAM.replace("TRUSTED_OWNER_UIDS=(0,)", `TRUSTED_OWNER_UIDS=(${[...owners].join(",")},)`);
  configure();
});
afterEach(async () => { vi.restoreAllMocks(); await adapter?.dispose(); if(root) await fs.rm(root,{recursive:true,force:true}); });

describe("fixed private repository initializer and bounded session transport", () => {
  it("atomically creates a verified repository and independently inspects its bound marker",async () => {
    expect(await run()).toMatchObject({status:"SUCCEEDED",state:"READY",head:graph.head,branch:"main",cleanupConfirmed:true,cancellationConfirmed:true});
    expect(await fs.readFile(path.join(root,"repo/source.ts"),"utf8")).toBe("const unicode = '你好 🌍';\n");
    expect(await run("inspect")).toMatchObject({status:"SUCCEEDED",state:"READY",head:graph.head});
    expect(await fs.readdir(root)).toEqual(["repo"]);
    for(const call of adapter.calls.commands) {
      expect(call.request.suppressInputEcho).toBe(true);
      expect(call.request.command).not.toContain(graph.head);
      expect(call.request.command).not.toContain(graph.objects[0].contentBase64);
    }
  });
  it("reports absent without creating a repository",async () => {
    expect(await run("inspect")).toMatchObject({status:"SUCCEEDED",state:"ABSENT",head:null,branch:null});
    expect(await fs.readdir(root)).toEqual([]);
  });
  it("reports interrupted staging as incomplete and refuses automatic initialization",async () => {
    await fs.mkdir(path.join(root,".cr8or-init-abandoned"));
    expect(await run("inspect")).toMatchObject({status:"SUCCEEDED",state:"INCOMPLETE"});
    expect(await run()).toMatchObject({status:"FAILED"});
    expect(await fs.readdir(root)).toEqual([".cr8or-init-abandoned"]);
  });
  it.each(["file","directory","symlink"])("preserves a preexisting %s destination",async kind => {
    const destination=path.join(root,"repo");
    if(kind==="file") await fs.writeFile(destination,"existing");
    else if(kind==="directory") {await fs.mkdir(destination);await fs.writeFile(path.join(destination,"original"),"history");}
    else {await fs.mkdir(path.join(root,"elsewhere"));await fs.symlink(path.join(root,"elsewhere"),destination);}
    expect(await run()).toMatchObject({status:"FAILED"});
    if(kind==="file") expect(await fs.readFile(destination,"utf8")).toBe("existing");
    else if(kind==="directory") expect(await fs.readFile(path.join(destination,"original"),"utf8")).toBe("history");
    else expect((await fs.lstat(destination)).isSymbolicLink()).toBe(true);
  });
  it("never overwrites a destination created after staging",async () => {
    configure({ onLogs: async logs => { if(logs.stdout.includes(" STAGED\n") && !logs.stdout.includes(" RESULT ")) await fs.mkdir(path.join(root,"repo"),{recursive:true}); } });
    expect(await run()).toMatchObject({status:"FAILED"});
    expect(await fs.readdir(path.join(root,"repo"))).toEqual([]);
    expect(await fs.readdir(root)).toEqual(["repo"]);
  });
  it("fails closed without Linux no-replace atomic rename",async () => {
    program=program.replace('rename=getattr(libc,"renameat2",None)','rename=None');
    expect(await run()).toMatchObject({status:"FAILED"});
    expect(await fs.readdir(root)).toEqual([]);
  });
  it("revocation after staging prevents publication and cleans only its own staging directory",async () => {
    let revoked=false;
    configure({onLogs:logs=>{if(logs.stdout.includes(" STAGED\n")) revoked=true;}});
    await expect(run("initialize",async()=>{if(revoked) throw new ExecutionAuthorizationError(401);})).rejects.toMatchObject({status:401});
    expect(adapter.calls.inputs.some(input=>input.data==="COMMIT\n")).toBe(false);
    expect(await fs.readdir(root)).toEqual([]);
  });
  it("aborted authorization cannot initialize a provider session",async () => {
    const abort=new AbortController();abort.abort();
    await expect(run("initialize",undefined,abort.signal)).rejects.toMatchObject({status:401});
    expect(adapter.calls.created).toEqual([]);
  });
  it("rejects credential generation changes during transfer",async () => {
    let rotated=false;
    configure({onLogs:logs=>{if(logs.stdout.includes(" STAGED\n")) rotated=true;}});
    await expect(run("initialize",async()=>{if(rotated) throw new ExecutionAuthorizationError(401);})).rejects.toMatchObject({status:401});
    expect(await fs.readdir(root)).toEqual([]);
  });
  it("detects unexpected repository marker identity without adopting the existing repository",async () => {
    expect((await run()).status).toBe("SUCCEEDED");
    metadata={...metadata,operationId:"different-operation"};
    expect(await run("inspect")).toMatchObject({status:"SUCCEEDED",state:"UNEXPECTED"});
    expect(await run()).toMatchObject({status:"FAILED"});
  });
  it.each(["config","HEAD","worktree","symlink","hardlink","extra"])("rejects independently inspected %s corruption",async kind => {
    expect((await run()).status).toBe("SUCCEEDED");
    const repo=path.join(root,"repo");
    if(kind==="config") await fs.appendFile(path.join(repo,".git/config"),"[alias]\n unsafe = !shell\n");
    if(kind==="HEAD") await fs.writeFile(path.join(repo,".git/HEAD"),"ref: refs/heads/other\n");
    if(kind==="worktree") await fs.writeFile(path.join(repo,"source.ts"),"modified");
    if(kind==="symlink") {await fs.unlink(path.join(repo,"source.ts"));await fs.symlink("/etc/passwd",path.join(repo,"source.ts"));}
    if(kind==="hardlink") await fs.link(path.join(repo,"source.ts"),path.join(root,"linked"));
    if(kind==="extra") await fs.writeFile(path.join(repo,"unexpected"),"unexpected");
    expect(await run("inspect")).toMatchObject({status:"SUCCEEDED",state:"UNEXPECTED"});
  });
  it.each(["config", "index"])("rejects a FIFO %s promptly without waiting for a writer",async name => {
    expect((await run()).status).toBe("SUCCEEDED");
    const destination = path.join(root, "repo/.git", name);
    await fs.unlink(destination);
    await promisify(execFile)("mkfifo", [destination]);
    const before = performance.now();
    expect(await run("inspect")).toMatchObject({status:"SUCCEEDED",state:"UNEXPECTED"});
    expect(performance.now() - before).toBeLessThan(3000);
    expect((await fs.lstat(destination)).isFIFO()).toBe(true);
    expect(await fs.readFile(path.join(root,"repo/source.ts"),"utf8")).toBe("const unicode = '你好 🌍';\n");
  });
  it("rejects tampered object bytes before contacting Daytona",async () => {
    graph.objects[0].contentBase64=Buffer.from("tampered").toString("base64");
    await expect(run()).rejects.toMatchObject({status:503});
    expect(adapter.calls.created).toEqual([]);
  });
  it("rejects oversized graphs before contacting Daytona",async () => {
    graph.objects[0].contentBase64=Buffer.alloc(256*1024+1).toString("base64");
    await expect(run()).rejects.toMatchObject({status:503});
    expect(adapter.calls.created).toEqual([]);
  });
  it("sanitizes provider failure details and never reports success",async () => {
    adapter.executeSessionCommand=async()=>{throw new Error("credential=synthetic-secret")};
    const result=await run();
    expect(result.status).toBe("UNKNOWN");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
  it("requires confirmed SDK session cleanup before reporting success",async () => {
    const remove=adapter.deleteSession;
    adapter.deleteSession=async()=>{throw new Error("synthetic cleanup failure")};
    expect(await run()).toMatchObject({status:"UNKNOWN",cleanupConfirmed:false});
    adapter.deleteSession=remove;
  });
  it("interrupts incomplete transfer without creating a destination",async () => {
    const send=adapter.sendSessionCommandInput;
    adapter.sendSessionCommandInput=async(session,command,data)=>{
      if(data.startsWith('{"version"')) {await send(session,command,data.slice(0,30));throw new Error("synthetic disconnect");}
      return send(session,command,data);
    };
    expect((await run()).status).toBe("UNKNOWN");
    await expect(fs.stat(path.join(root,"repo"))).rejects.toMatchObject({code:"ENOENT"});
  });
  it("independently rejects tampering inside the provider input channel",async () => {
    const send=adapter.sendSessionCommandInput;
    adapter.sendSessionCommandInput=async(session,command,data)=>{
      if(data.startsWith('{"version"')) data=data.replace(graph.objects[0].contentBase64, "A"+graph.objects[0].contentBase64.slice(1));
      return send(session,command,data);
    };
    expect(await run()).toMatchObject({status:"FAILED"});
    expect(await fs.readdir(root)).toEqual([]);
  });
  it("honors the remote duration deadline without publishing partial content",async () => {
    program=program.replace("deadline=time.monotonic()+35","deadline=time.monotonic()+.05");
    const result=await run();
    expect(result.status).not.toBe("SUCCEEDED");
    await expect(fs.stat(path.join(root,"repo"))).rejects.toMatchObject({code:"ENOENT"});
  });
  it("rejects excessive provider output without releasing its contents",async () => {
    configure({transformLogs:logs=>({...logs,stdout:"private-output".repeat(1000),output:"private-output".repeat(1000)})});
    const result=await run();
    expect(result.status).toBe("UNKNOWN");
    expect(JSON.stringify(result)).not.toContain("private-output");
  });
  it("refuses an excessive existing parent directory before staging",async () => {
    await Promise.all(Array.from({length:2050},(_,index)=>fs.writeFile(path.join(root,`existing-${index}`),"")));
    expect(await run()).toMatchObject({status:"FAILED"});
    expect((await fs.readdir(root)).length).toBe(2050);
    await expect(fs.stat(path.join(root,"repo"))).rejects.toMatchObject({code:"ENOENT"});
  });
});
