import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGitOperationScope } from "@/lib/security/git-operation-catalogue";
import {
  GIT_OBJECT_TRANSFER_LIMITS, GitObjectTransferError, gitObjectId, serializeGitCommit, serializeGitTree,
  validateGitObjectTransfer, type GitTransferCommitFields, type GitTransferObjectType,
} from "@/lib/security/git-object-transfer";

const BASE = "a".repeat(40);
const IDENTITY = { name: "Cr8or Studio", email: "owner@cr8or.invalid", timestamp: 1700000000, date: "2023-11-14T22:13:20.000Z" };
type WireObject = { oid: string; type: GitTransferObjectType; contentBase64: string };
type Wire = { version: number; repositoryKey: string; branch: string; head: string; base: string; objects: WireObject[] };
function object(type: GitTransferObjectType, content: Buffer): WireObject {
  return { oid: gitObjectId(type, content), type, contentBase64: content.toString("base64") };
}
function commit(tree: string, parent = BASE, message = "CR8OR-001: General maintenance\n", patch: Partial<GitTransferCommitFields> = {}): WireObject {
  return object("commit", serializeGitCommit({ tree, parent, author: IDENTITY, committer: IDENTITY, message, ...patch }));
}
function fixture(content = Buffer.from("source = '😀 café';\r\n")): Wire {
  const blob = object("blob", content);
  const tree = object("tree", serializeGitTree([{ mode: "100644", name: "source.ts", oid: blob.oid, type: "blob" }]));
  const head = commit(tree.oid);
  return { version: 1, repositoryKey: "badadeveloper001-dev/cr8or-studio", branch: "main", head: head.oid, base: BASE, objects: [head, tree, blob] };
}
function scope(graph: Wire) {
  return buildGitOperationScope({ projectId: "registered-project", workspace: { id: "registered-workspace", runtimeType: "cloud", provider: "daytona",
    providerWorkspaceId: "registered-sandbox", repositoryUrl: "https://github.com/badadeveloper001-dev/Cr8or-Studio.git", branch: "main" } },
  { operation: "push", branch: "main", targetCommit: graph.head, expectedRemoteHead: graph.base });
}
function changeCommit(graph: Wire, content: Buffer): void {
  const replacement = object("commit", content);
  graph.objects[0] = replacement; graph.head = replacement.oid;
}
function replaceTree(graph: Wire, content: Buffer): void {
  const tree = object("tree", content);
  graph.objects[1] = tree;
  const replacement = commit(tree.oid);
  graph.objects[0] = replacement; graph.head = replacement.oid;
}
function rawEntry(mode: string, name: string | Buffer, objectId: string): Buffer {
  return Buffer.concat([Buffer.from(`${mode} `), Buffer.from(name), Buffer.from([0]), Buffer.from(objectId, "hex")]);
}

describe("bounded raw Git object integrity", () => {
  it.each([Buffer.alloc(0), Buffer.from("café 😀\0\r\n"), Buffer.from([0, 255, 128, 65])])("preserves exact empty, UTF-8 and binary blobs %#", content => {
    const graph = fixture(content), result = validateGitObjectTransfer(graph, scope(graph));
    expect(result.objects.get(graph.objects[2].oid)?.content).toEqual(content);
    expect(result.commits.map(item => item.oid)).toEqual([graph.head]);
    expect(serializeGitCommit(result.commits[0])).toEqual(Buffer.from(graph.objects[0].contentBase64, "base64"));
    for (const item of result.objects.values()) expect(gitObjectId(item.type, item.content)).toBe(item.oid);
  });
  it("validates a complete two-commit chain and uploads parents first", () => {
    const graph = fixture();
    const next = commit(graph.objects[1].oid, graph.head, "CR8OR-002: Code improvements\n");
    graph.objects.unshift(next); graph.head = next.oid;
    const result = validateGitObjectTransfer(graph, scope(graph));
    expect(result.commits.map(item => item.message)).toEqual(["CR8OR-001: General maintenance\n", "CR8OR-002: Code improvements\n"]);
  });
  it.each(["OTHER-001: General maintenance\n", "CR8OR-000: General maintenance\n", "CR8OR-1: General maintenance\n", "CR8OR-0001: General maintenance\n",
    "CR8OR-001: Sensitive implementation details\n", "CR8OR-001: General maintenance", "CR8OR-001: General maintenance\n\nBody\n"])(
    "rejects untrusted or unsupported commit naming %j without rewriting it", message => {
      const graph = fixture(), replacement = commit(graph.objects[1].oid, BASE, message);
      graph.objects[0] = replacement; graph.head = replacement.oid;
      expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
    },
  );
  it.each([1, 2])("rejects duplicate or reversing commit sequence %s", sequence => {
    const graph = fixture(), initial = commit(graph.objects[1].oid, BASE, "CR8OR-002: General maintenance\n");
    const next = commit(graph.objects[1].oid, initial.oid, `CR8OR-${String(sequence).padStart(3, "0")}: Code improvements\n`);
    graph.objects[0] = initial; graph.objects.push(next); graph.head = next.oid;
    expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
  });
  it.each(["repositoryKey", "branch", "head", "base"] as const)("rejects substitution of approved %s", key => {
    const graph = fixture(), approved = scope(graph);
    graph[key] = key === "repositoryKey" ? "unrelated/repository" : key === "branch" ? "other" : "b".repeat(40);
    expect(() => validateGitObjectTransfer(graph, approved)).toThrow(GitObjectTransferError);
  });
  it.each(["commit", "tree", "blob"] as const)("rejects tampering with %s bytes", type => {
    const graph = fixture(), target = graph.objects.find(item => item.type === type)!;
    target.contentBase64 = Buffer.from("tampered source must never appear in the error").toString("base64");
    expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(/^Git object transfer could not be verified\.$/);
  });
  it.each(["eA", "eA=", "eA===", "eB==", "eA==\n", "!!!!", "4oK_"])("rejects malformed or noncanonical base64 %j", encoding => {
    const graph = fixture(); graph.objects[2].contentBase64 = encoding;
    expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
  });
  it.each(["commit", "tree", "blob"] as const)("rejects incomplete graphs missing %s", type => {
    const graph = fixture(); graph.objects = graph.objects.filter(item => item.type !== type);
    expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
  });
  it("rejects missing ancestry instead of inventing a root or changing the remote base", () => {
    const graph = fixture(); changeCommit(graph, serializeGitCommit({ tree: graph.objects[1].oid, parent: "b".repeat(40), author: IDENTITY, committer: IDENTITY, message: "Change\n" }));
    expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
  });
  it("rejects duplicate, extra and unsupported objects", () => {
    for (const extra of [fixture().objects[2], object("blob", Buffer.from("unreachable")), { oid: "b".repeat(40), type: "tag", contentBase64: "" }]) {
      const graph = fixture(); graph.objects.push(extra as WireObject);
      expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
    }
  });
  it("does not accept exported remote-anchor commits or SHA-256 object names", () => {
    for (const replacement of [BASE, "b".repeat(64)]) {
      const graph = fixture(); graph.objects[2].oid = replacement;
      expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
    }
  });
  it.each([
    (text: string) => text.replace("\nauthor ", `\nparent ${"b".repeat(40)}\nauthor `),
    (text: string) => text.replace(/parent [^\n]+\n/, ""),
    (text: string) => text.replace("\n\n", "\ngpgsig unsupported\n\n"),
    (text: string) => text.replace("\n\n", "\nencoding UTF-8\n\n"),
    (text: string) => text.replace("\n\n", "\nmergetag unsupported\n\n"),
    (text: string) => text.replace(/\+0000/g, "+0100"),
    (text: string) => text.replace(/1700000000/g, "0"),
    (text: string) => text.replace(/1700000000/g, "01700000000"),
    (text: string) => text.replace(/1700000000/g, "253402300800"),
    (text: string) => text.replace(/1700000000/g, "-1"),
    (text: string) => text.replace(/\n/g, "\r\n"),
    (text: string) => `${text}\0`,
  ])("rejects unsupported or noncanonical commit representation %#", mutate => {
    const graph = fixture(); changeCommit(graph, Buffer.from(mutate(Buffer.from(graph.objects[0].contentBase64, "base64").toString("utf8"))));
    expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
  });
  it("rejects invalid UTF-8 commits and tree names", () => {
    const graph = fixture(); changeCommit(graph, Buffer.concat([Buffer.from(graph.objects[0].contentBase64, "base64"), Buffer.from([255])]));
    expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
    const other = fixture(); replaceTree(other, rawEntry("100644", Buffer.from([255]), other.objects[2].oid));
    expect(() => validateGitObjectTransfer(other, scope(other))).toThrow(GitObjectTransferError);
  });
  it.each(["120000", "160000", "100664", "040000", "100600"])("rejects unsupported tree mode %s", mode => {
    const graph = fixture(); replaceTree(graph, rawEntry(mode, "source.ts", graph.objects[2].oid));
    expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
  });
  it.each(["../outside", "/absolute", "nested/path", "-option", ".git", ".GitModules", ".gitattributes", ".env", ".env.example", "secret", "secrets", "credentials", "credential", ".aws", ".ssh", ".npmrc", ".netrc", "id_rsa", "id_ed25519", "server.KEY", "cert.pem", "x".repeat(256), "line\nbreak"])("rejects unsafe/sensitive tree name %j", name => {
    const graph = fixture(); replaceTree(graph, rawEntry("100644", name, graph.objects[2].oid));
    expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
  });
  it("enforces canonical Git tree order, unique names, complete entries and referenced types", () => {
    const graph = fixture(), blob = graph.objects[2].oid;
    for (const bytes of [Buffer.concat([rawEntry("100644", "z", blob), rawEntry("100644", "a", blob)]),
      Buffer.concat([rawEntry("100644", "a", blob), rawEntry("100644", "a", blob)]),
      rawEntry("100644", "a", blob).subarray(0, -1), rawEntry("40000", "src", blob)]) {
      const copy = fixture(); replaceTree(copy, bytes);
      expect(() => validateGitObjectTransfer(copy, scope(copy))).toThrow(GitObjectTransferError);
    }
  });
  it("rejects oversized objects before allocating their full decoded contents", () => {
    const graph = fixture(); graph.objects[2].contentBase64 = "A".repeat(Math.ceil((GIT_OBJECT_TRANSFER_LIMITS.objectBytes + 3) / 3) * 4);
    expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
  });
  it("rejects too many objects and commits", () => {
    const graph = fixture(); graph.objects = Array.from({ length: 129 }, () => graph.objects[0]);
    expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
    const chain = fixture();
    for (let index = 2; index <= 17; index++) { const next = commit(chain.objects[1].oid, chain.head, `Change ${index}\n`); chain.objects.push(next); chain.head = next.oid; }
    expect(() => validateGitObjectTransfer(chain, scope(chain))).toThrow(GitObjectTransferError);
  });
  it("rejects total object bytes beyond one MiB", () => {
    const graph = fixture();
    for (let index = 0; index < 5; index++) graph.objects.push(object("blob", Buffer.alloc(256 * 1024, index)));
    expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
  });
  it("bounds nested tree expansion and depth", () => {
    const graph = fixture(), blob = graph.objects[2];
    let child = object("tree", serializeGitTree([{ mode: "100644", name: "file", oid: blob.oid, type: "blob" }]));
    const trees = [child];
    for (let depth = 0; depth < 33; depth++) { child = object("tree", serializeGitTree([{ mode: "40000", name: "dir", oid: child.oid, type: "tree" }])); trees.push(child); }
    const head = commit(child.oid); graph.head = head.oid; graph.objects = [head, ...trees, blob];
    expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
  });
  it("requires the exact versioned wire contract and a valid push scope", () => {
    const graph = fixture();
    for (const value of [{ ...graph, token: "never accepted" }, { ...graph, version: 2 }, { ...graph, objects: {} }, null]) {
      expect(() => validateGitObjectTransfer(value, scope(graph))).toThrow(GitObjectTransferError);
    }
    expect(() => validateGitObjectTransfer(graph, { ...scope(graph), operationKey: "status" })).toThrow(GitObjectTransferError);
    expect(() => validateGitObjectTransfer(graph, { ...scope(graph), ownerId: "forged" } as never)).toThrow(GitObjectTransferError);
  });
});

describe("real disposable Git object compatibility", () => {
  let directory: string, base: string, first: string, head: string;
  const execute = promisify(execFile);
  const git = async (...args: string[]) => (await execute("git", args, { cwd: directory, encoding: "buffer", env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_DATE: "1700000000 +0000", GIT_COMMITTER_DATE: "1700000000 +0000" }, maxBuffer: 4 * 1024 * 1024 })).stdout;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "cr8or-object-integrity-"));
    await git("init", "--quiet", "--initial-branch=main"); await git("config", "user.name", "Cr8or Studio"); await git("config", "user.email", "owner@cr8or.invalid");
    writeFileSync(join(directory, "README.md"), "Original history\n"); await git("add", "README.md"); await git("commit", "--quiet", "-m", "Initial changes"); base = (await git("rev-parse", "HEAD")).toString().trim();
    mkdirSync(join(directory, "src")); writeFileSync(join(directory, "src", "café.ts"), "export const value = '😀';\r\n");
    writeFileSync(join(directory, "empty"), ""); writeFileSync(join(directory, "binary"), Buffer.from([255, 0, 128]));
    await git("add", "."); await git("commit", "--quiet", "-m", "CR8OR-001: Code improvements"); first = (await git("rev-parse", "HEAD")).toString().trim();
    writeFileSync(join(directory, "src", "café.ts"), "export const value = 'updated café';\n"); await git("add", ".");
    await git("commit", "--quiet", "-m", "CR8OR-002: Code improvements"); head = (await git("rev-parse", "HEAD")).toString().trim();
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  async function exportGraph(): Promise<Wire> {
    const objects = new Map<string, WireObject>();
    async function collectTree(tree: string): Promise<void> {
      if (objects.has(tree)) return;
      objects.set(tree, object("tree", await git("cat-file", "tree", tree)));
      const listing = (await git("ls-tree", "-z", tree)).toString("utf8").split("\0").filter(Boolean);
      for (const line of listing) {
        const match = /^(\d+) (tree|blob) ([0-9a-f]{40})\t/.exec(line)!;
        if (match[2] === "tree") await collectTree(match[3]);
        else objects.set(match[3], object("blob", await git("cat-file", "blob", match[3])));
      }
    }
    for (const current of [first, head]) {
      const bytes = await git("cat-file", "commit", current);
      objects.set(current, object("commit", bytes)); await collectTree(/^tree ([0-9a-f]{40})\n/.exec(bytes.toString())![1]);
    }
    return { version: 1, repositoryKey: "badadeveloper001-dev/cr8or-studio", branch: "main", head, base, objects: [...objects.values()] };
  }
  it("verifies actual Git-produced commit, tree and binary blob SHAs without rewriting history", async () => {
    const graph = await exportGraph(), result = validateGitObjectTransfer(graph, scope(graph));
    expect(result.head).toBe(head); expect(result.base).toBe(base); expect(result.commits.map(item => item.oid)).toEqual([first, head]);
    for (const item of result.objects.values()) {
      expect(item.content).toEqual(await git("cat-file", item.type, item.oid));
      if (item.type === "tree") expect(serializeGitTree(item.entries)).toEqual(item.content);
    }
    expect((await git("rev-list", "--count", "HEAD")).toString().trim()).toBe("3");
    expect((await git("rev-parse", "HEAD~2")).toString().trim()).toBe(base);
  });
  it("detects missing unchanged blobs needed by a complete source tree", async () => {
    const graph = await exportGraph(); const readme = (await git("rev-parse", `${head}:README.md`)).toString().trim();
    graph.objects = graph.objects.filter(item => item.oid !== readme);
    expect(() => validateGitObjectTransfer(graph, scope(graph))).toThrow(GitObjectTransferError);
  });
});
