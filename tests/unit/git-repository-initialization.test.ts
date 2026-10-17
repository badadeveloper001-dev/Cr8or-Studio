import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitObjectId, serializeGitTree, type GitTransferObjectType } from "@/lib/security/git-object-transfer";
import {
  GIT_REPOSITORY_INITIALIZATION_LIMITS, RepositoryInitializationIntegrityError, parseRepositoryCommit,
  serializeRepositoryCommit, validateRepositoryInitialization, validateRepositoryInitializationBinding,
  type RepositoryCommitFields, type RepositoryInitializationBinding,
} from "@/lib/security/git-repository-initialization";

const IDENTITY = { name: "Historical Author", email: "author@example.invalid", timestamp: 1700000000, date: "2023-11-14T22:13:20.000Z" };
type WireObject = { oid: string; type: GitTransferObjectType; contentBase64: string };
type Wire = { version: number; repositoryKey: string; branch: string; head: string; objects: WireObject[] };
function object(type: GitTransferObjectType, bytes: Buffer): WireObject {
  return { oid: gitObjectId(type, bytes), type, contentBase64: bytes.toString("base64") };
}
function commit(tree: string, parent: string | null = null, message = "An existing historical commit\n\nIts original body remains intact.\n", extra: Partial<RepositoryCommitFields> = {}): WireObject {
  return object("commit", serializeRepositoryCommit({ tree, parent, author: IDENTITY, committer: IDENTITY, message, ...extra }));
}
function fixture(bytes = Buffer.from("café 😀\r\n")): Wire {
  const blob = object("blob", bytes);
  const tree = object("tree", serializeGitTree([{ mode: "100644", name: "source.ts", type: "blob", oid: blob.oid }]));
  const head = commit(tree.oid);
  return { version: 1, repositoryKey: "registered/project", branch: "main", head: head.oid, objects: [head, tree, blob] };
}
function binding(graph: Wire): RepositoryInitializationBinding { return { repositoryKey: graph.repositoryKey, branch: graph.branch, head: graph.head }; }
function replaceCommit(graph: Wire, content: Buffer): void {
  const head = object("commit", content); graph.objects[0] = head; graph.head = head.oid;
}
function replaceTree(graph: Wire, content: Buffer): void {
  const tree = object("tree", content); graph.objects[1] = tree;
  const head = commit(tree.oid); graph.objects[0] = head; graph.head = head.oid;
}
function rawEntry(mode: string, name: string | Buffer, sha: string): Buffer {
  return Buffer.concat([Buffer.from(`${mode} `), Buffer.from(name), Buffer.from([0]), Buffer.from(sha, "hex")]);
}

describe("complete repository initialization graph", () => {
  it.each([Buffer.alloc(0), Buffer.from([255, 0, 128, 13, 10]), Buffer.from("Unicode 😀 café\r\n")])("preserves exact empty/binary/UTF-8 content %#", bytes => {
    const graph = fixture(bytes), result = validateRepositoryInitialization(graph, binding(graph));
    expect(result.objects.get(graph.objects[2].oid)?.content).toEqual(bytes);
    expect(result.commits[0].parent).toBeNull();
    expect(serializeRepositoryCommit(result.commits[0])).toEqual(Buffer.from(graph.objects[0].contentBase64, "base64"));
    for (const value of result.objects.values()) expect(gitObjectId(value.type, value.content)).toBe(value.oid);
  });
  it("supports an empty repository tree with its root commit", () => {
    const graph = fixture(), tree = object("tree", Buffer.alloc(0)), head = commit(tree.oid);
    graph.head = head.oid; graph.objects = [head, tree];
    expect(validateRepositoryInitialization(graph, binding(graph)).objects.size).toBe(2);
  });
  it.each(["", "historical title without naming convention", "PROJECT-001: General maintenance\n", "body\n\n😀 retained\r\n"])("does not rename or normalize historical message %j", message => {
    const graph = fixture(), next = commit(graph.objects[1].oid, null, message);
    graph.head = next.oid; graph.objects[0] = next;
    expect(validateRepositoryInitialization(graph, binding(graph)).commits[0].message).toBe(message);
  });
  it("validates complete root ancestry and returns oldest-first order", () => {
    const graph = fixture(), original = graph.head;
    for (let i = 0; i < 3; i++) { const next = commit(graph.objects[1].oid, graph.head, `Original ${i}\n`); graph.objects.push(next); graph.head = next.oid; }
    const result = validateRepositoryInitialization(graph, binding(graph));
    expect(result.commits.map(item => item.message)).toEqual(["An existing historical commit\n\nIts original body remains intact.\n", "Original 0\n", "Original 1\n", "Original 2\n"]);
    expect(result.commits[0].oid).toBe(original);
    expect(result.commits.at(-1)?.oid).toBe(graph.head);
  });
  it.each(["repositoryKey", "branch", "head"] as const)("rejects a different approved %s", key => {
    const graph = fixture(), approved = binding(graph);
    graph[key] = key === "repositoryKey" ? "unrelated/project" : key === "branch" ? "other" : "a".repeat(40);
    expect(() => validateRepositoryInitialization(graph, approved)).toThrow(RepositoryInitializationIntegrityError);
  });
  it.each([
    { repositoryKey: "Registered/Project" }, { repositoryKey: "credential@github.com/repo" }, { repositoryKey: "github.com/owner/repo" },
    { repositoryKey: "../repo" }, { branch: "../../main" }, { branch: "refs/heads/main" }, { branch: "main;echo x" },
    { branch: "main.lock" }, { branch: "HEAD" }, { head: "b".repeat(64) }, { ownerId: "owner" },
  ])("rejects malformed or noncanonical bindings %#", patch => {
    expect(() => validateRepositoryInitializationBinding({ ...binding(fixture()), ...patch })).toThrow(RepositoryInitializationIntegrityError);
  });
  it.each(["commit", "tree", "blob"] as const)("rejects missing %s rather than initializing partial history", type => {
    const graph = fixture(); graph.objects = graph.objects.filter(value => value.type !== type);
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
  });
  it("rejects a missing parent even when the entire HEAD tree is available", () => {
    const graph = fixture(), head = commit(graph.objects[1].oid, "a".repeat(40));
    graph.objects[0] = head; graph.head = head.oid;
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
  });
  it.each(["commit", "tree", "blob"] as const)("rejects altered %s bytes without disclosing them", type => {
    const graph = fixture(); graph.objects.find(item => item.type === type)!.contentBase64 = Buffer.from("sensitive altered contents").toString("base64");
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(/^Repository initialization could not be verified\.$/);
  });
  it.each(["eA", "eA=", "eB==", "eA==\n", "====", "4oK_"])("rejects malformed Base64 %j", contentBase64 => {
    const graph = fixture(); graph.objects[2].contentBase64 = contentBase64;
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
  });
  it.each(["tag", "delta", "ofs-delta"])("rejects unsupported object kind %s", type => {
    const graph = fixture(); (graph.objects[0] as { type: string }).type = type;
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
  });
  it("rejects extra, duplicate and wrong-type referenced objects", () => {
    for (const extra of [fixture().objects[2], object("blob", Buffer.from("unreachable")), commit(fixture().objects[1].oid)]) {
      const graph = fixture(); graph.objects.push(extra);
      expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
    }
    const graph = fixture(); replaceTree(graph, rawEntry("40000", "directory", graph.objects[2].oid));
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
  });
  it.each([
    (value: string) => value.replace("\nauthor ", `\nparent ${"a".repeat(40)}\nparent ${"b".repeat(40)}\nauthor `),
    (value: string) => value.replace("\n\n", "\ngpgsig unsupported\n\n"),
    (value: string) => value.replace("\n\n", "\nencoding UTF-8\n\n"),
    (value: string) => value.replace("\n\n", "\nmergetag unsupported\n\n"),
    (value: string) => value.replace(/\+0000/g, "-0700"),
    (value: string) => value.replace(/1700000000/g, "0"),
    (value: string) => value.replace(/1700000000/g, "01700000000"),
    (value: string) => value.replace(/1700000000/g, "253402300800"),
    (value: string) => value.replace(/\n/g, "\r\n"),
    (value: string) => `${value}\0`,
  ])("rejects unsupported or unreconstructable commit formats %#", mutate => {
    const graph = fixture(); replaceCommit(graph, Buffer.from(mutate(Buffer.from(graph.objects[0].contentBase64, "base64").toString("utf8"))));
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
  });
  it("rejects non-UTF-8 commit bytes or filenames", () => {
    const graph = fixture(); replaceCommit(graph, Buffer.concat([Buffer.from(graph.objects[0].contentBase64, "base64"), Buffer.from([255])]));
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
    const other = fixture(); replaceTree(other, rawEntry("100644", Buffer.from([255]), other.objects[2].oid));
    expect(() => validateRepositoryInitialization(other, binding(other))).toThrow(RepositoryInitializationIntegrityError);
  });
  it.each(["120000", "160000", "100664", "040000"])("rejects unsupported file mode %s", mode => {
    const graph = fixture(); replaceTree(graph, rawEntry(mode, "entry", graph.objects[2].oid));
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
  });
  it.each(["../file", "/root", "nested/path", ".git", ".GitModules", ".gitattributes", ".env", ".env.example", ".aws", ".ssh", ".config", ".Config", ".npmrc", ".netrc", "credentials", "secrets", "private.key", "cert.pem", "-option", "x".repeat(256)])("rejects forbidden tree path %j", name => {
    const graph = fixture(); replaceTree(graph, rawEntry("100644", name, graph.objects[2].oid));
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
  });
  it("does not overlook a sensitive file deleted in a later commit", () => {
    const graph = fixture(), tree = object("tree", rawEntry("100644", ".env", graph.objects[2].oid));
    const root = commit(tree.oid), next = commit(graph.objects[1].oid, root.oid, "Remove private file\n");
    graph.objects[0] = root; graph.objects.push(tree, next); graph.head = next.oid;
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
  });
  it("enforces canonical tree ordering and entry uniqueness", () => {
    for (const names of [["z", "a"], ["a", "a"]]) {
      const graph = fixture(); replaceTree(graph, Buffer.concat(names.map(name => rawEntry("100644", name, graph.objects[2].oid))));
      expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
    }
  });
  it("enforces bounded history without returning a shallow result", () => {
    const graph = fixture();
    for (let i = 1; i < GIT_REPOSITORY_INITIALIZATION_LIMITS.commits; i++) {
      const next = commit(graph.objects[1].oid, graph.head, `Commit ${i}\n`); graph.objects.push(next); graph.head = next.oid;
    }
    expect(validateRepositoryInitialization(graph, binding(graph)).commits).toHaveLength(16);
    const next = commit(graph.objects[1].oid, graph.head); graph.objects.push(next); graph.head = next.oid;
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
  });
  it("rejects object counts, individual sizes and total sizes above their bounds", () => {
    const graph = fixture(); graph.objects = Array.from({ length: 129 }, () => graph.objects[0]);
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
    const large = fixture(Buffer.alloc(256 * 1024 + 1));
    expect(() => validateRepositoryInitialization(large, binding(large))).toThrow(RepositoryInitializationIntegrityError);
    const total = fixture(); for (let i = 0; i < 5; i++) total.objects.push(object("blob", Buffer.alloc(256 * 1024, i)));
    expect(() => validateRepositoryInitialization(total, binding(total))).toThrow(RepositoryInitializationIntegrityError);
  });
  it("bounds materialized HEAD bytes when distinct file paths reuse the same blob", () => {
    const blob = object("blob", Buffer.alloc(256 * 1024));
    const build = (copies: number): Wire => {
      const tree = object("tree", serializeGitTree(Array.from({ length: copies }, (_, index) => ({
        mode: "100644" as const, name: `file-${index}`, type: "blob" as const, oid: blob.oid,
      }))));
      const head = commit(tree.oid);
      return { version: 1, repositoryKey: "registered/project", branch: "main", head: head.oid, objects: [head, tree, blob] };
    };
    const bounded = build(4), excessive = build(5);
    expect(validateRepositoryInitialization(bounded, binding(bounded)).totalBytes).toBeLessThan(1024 * 1024);
    expect(() => validateRepositoryInitialization(excessive, binding(excessive))).toThrow(RepositoryInitializationIntegrityError);
  });
  it("checks nested sensitive configuration directories independently of shared tree parsing", () => {
    const graph = fixture(), blob = graph.objects[2];
    const nested = object("tree", serializeGitTree([{ mode: "100644", name: "settings", type: "blob", oid: blob.oid }]));
    const root = object("tree", serializeGitTree([{ mode: "40000", name: ".config", type: "tree", oid: nested.oid }]));
    const head = commit(root.oid); graph.head = head.oid; graph.objects = [head, root, nested, blob];
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
  });
  it("bounds tree depth and repeated tree expansion", () => {
    const graph = fixture(), blob = graph.objects[2];
    let tree = object("tree", serializeGitTree([{ mode: "100644", name: "source", type: "blob", oid: blob.oid }]));
    const trees = [tree];
    for (let i = 0; i < 33; i++) { tree = object("tree", serializeGitTree([{ mode: "40000", name: "dir", type: "tree", oid: tree.oid }])); trees.push(tree); }
    const head = commit(tree.oid); graph.head = head.oid; graph.objects = [head, ...trees, blob];
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
    const expanded = fixture();
    const many = object("tree", serializeGitTree(Array.from({ length: 40 }, (_, i) => ({ mode: "100644" as const, name: `file-${String(i).padStart(3, "0")}`, type: "blob" as const, oid: expanded.objects[2].oid }))));
    const first = commit(many.oid); expanded.objects = [first, many, expanded.objects[2]]; expanded.head = first.oid;
    for (let i = 0; i < 13; i++) { const next = commit(many.oid, expanded.head, `Commit ${i}\n`); expanded.objects.push(next); expanded.head = next.oid; }
    expect(() => validateRepositoryInitialization(expanded, binding(expanded))).toThrow(RepositoryInitializationIntegrityError);
  });
  it("requires an exact wire shape and does not accept credential metadata", () => {
    const graph = fixture();
    for (const value of [null, { ...graph, version: 2 }, { ...graph, base: "a".repeat(40) }, { ...graph, objects: {} }, { ...graph, token: "synthetic" }]) {
      expect(() => validateRepositoryInitialization(value, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
    }
    graph.objects[0] = { ...graph.objects[0], token: "synthetic" } as WireObject;
    expect(() => validateRepositoryInitialization(graph, binding(graph))).toThrow(RepositoryInitializationIntegrityError);
  });
  it("independently verifies the commit hash in its exported parser", () => {
    const graph = fixture(), bytes = Buffer.from(graph.objects[0].contentBase64, "base64");
    expect(() => parseRepositoryCommit("a".repeat(40), bytes)).toThrow(RepositoryInitializationIntegrityError);
  });
});

describe("complete history from a disposable real Git repository", () => {
  let directory: string, first: string, second: string, head: string;
  const execute = promisify(execFile);
  const git = async (...args: string[]) => (await execute("git", args, {
    cwd: directory, encoding: "buffer", timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
    env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_DATE: "1700000000 +0000", GIT_COMMITTER_DATE: "1700000000 +0000", TZ: "UTC" },
  })).stdout;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "cr8or-repository-integrity-"));
    await git("init", "--quiet", "--initial-branch=main");
    await git("config", "user.name", "Historical Author"); await git("config", "user.email", "author@example.invalid");
    writeFileSync(join(directory, "README.md"), "Root history\n"); await git("add", "README.md");
    await git("commit", "--quiet", "-m", "Original historical title", "-m", "Original message body."); first = (await git("rev-parse", "HEAD")).toString().trim();
    mkdirSync(join(directory, "src")); writeFileSync(join(directory, "src", "café.ts"), "export const emoji = '😀';\r\n");
    writeFileSync(join(directory, "empty"), ""); writeFileSync(join(directory, "binary"), Buffer.from([0, 255, 128, 13, 10]));
    await git("add", "."); await git("commit", "--quiet", "-m", "A second historical commit"); second = (await git("rev-parse", "HEAD")).toString().trim();
    writeFileSync(join(directory, "src", "café.ts"), "export const emoji = 'é';\n"); await git("add", ".");
    await git("commit", "--quiet", "-m", "A later change"); head = (await git("rev-parse", "HEAD")).toString().trim();
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  async function graph(): Promise<Wire> {
    const ids = (await git("rev-list", "--objects", "--no-object-names", "HEAD")).toString().trim().split("\n");
    const objects: WireObject[] = [];
    for (const sha of ids) {
      const type = (await git("cat-file", "-t", sha)).toString().trim() as GitTransferObjectType;
      objects.push(object(type, await git("cat-file", type, sha)));
    }
    return { version: 1, repositoryKey: "registered/project", branch: "main", head, objects };
  }
  it("retains exact original commit/tree/blob bytes and every root ancestor", async () => {
    const wire = await graph(), result = validateRepositoryInitialization(wire, binding(wire));
    expect(result.commits.map(commit => commit.oid)).toEqual([first, second, head]);
    expect(result.commits[0].message).toBe("Original historical title\n\nOriginal message body.\n");
    for (const item of result.objects.values()) expect(item.content).toEqual(await git("cat-file", item.type, item.oid));
    expect((await git("rev-list", "--count", "HEAD")).toString().trim()).toBe("3");
    expect((await git("rev-parse", "HEAD~2")).toString().trim()).toBe(first);
    expect(result.objects.get((await git("rev-parse", "HEAD:binary")).toString().trim())?.content).toEqual(Buffer.from([0, 255, 128, 13, 10]));
    expect(result.objects.get((await git("rev-parse", "HEAD:empty")).toString().trim())?.content.length).toBe(0);
  });
  it("rejects a shallow graph that has the final checkout but omits earlier history", async () => {
    const wire = await graph(); wire.objects = wire.objects.filter(item => item.oid !== first);
    expect(() => validateRepositoryInitialization(wire, binding(wire))).toThrow(RepositoryInitializationIntegrityError);
  });
  it("checks historical blobs even if their path has changed contents at HEAD", async () => {
    const wire = await graph(), historical = (await git("rev-parse", `${second}:src/café.ts`)).toString().trim();
    wire.objects = wire.objects.filter(item => item.oid !== historical);
    expect(() => validateRepositoryInitialization(wire, binding(wire))).toThrow(RepositoryInitializationIntegrityError);
  });
});
