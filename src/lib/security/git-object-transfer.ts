import "server-only";

import { createHash } from "node:crypto";
import { validateGitOperationScope, validGitPath, type GitOperationScope } from "@/lib/security/git-operation-catalogue";
import { formatGitPullTitle, GIT_PULL_CATEGORIES, resolveGitProjectCode } from "@/lib/security/git-project-naming";

/** The complete trees for each new commit are transferred. The approved remote
 * base is the only external graph edge; the GitHub adapter verifies that anchor.
 * No pack parsing, replacement refs, signatures, merges or alternate object
 * formats are accepted by this deliberately small transport. */
export const GIT_OBJECT_TRANSFER_LIMITS = Object.freeze({
  commits: 16, objects: 128, objectBytes: 256 * 1024, totalBytes: 1024 * 1024,
  encodedBytes: 2 * 1024 * 1024, treeEntries: 512, depth: 32, pathBytes: 4096,
});
export type GitTransferObjectType = "commit" | "tree" | "blob";
export type GitTransferTreeEntry = Readonly<{ mode: "100644" | "100755" | "40000"; name: string; oid: string; type: "blob" | "tree" }>;
export type GitTransferIdentity = Readonly<{ name: string; email: string; timestamp: number; date: string }>;
export type GitTransferCommitFields = Readonly<{ tree: string; parent: string; author: GitTransferIdentity; committer: GitTransferIdentity; message: string }>;
type BaseObject = Readonly<{ oid: string; content: Buffer }>;
export type ValidatedGitCommit = BaseObject & GitTransferCommitFields & Readonly<{ type: "commit" }>;
export type ValidatedGitTree = BaseObject & Readonly<{ type: "tree"; entries: readonly GitTransferTreeEntry[] }>;
export type ValidatedGitBlob = BaseObject & Readonly<{ type: "blob" }>;
export type ValidatedGitObject = ValidatedGitCommit | ValidatedGitTree | ValidatedGitBlob;
export type ValidatedGitObjectTransfer = Readonly<{
  version: 1; repositoryKey: string; branch: string; head: string; base: string;
  objects: ReadonlyMap<string, ValidatedGitObject>;
  /** Parents precede their children for GitHub object insertion. */
  commits: readonly ValidatedGitCommit[]; totalBytes: number;
}>;

export class GitObjectTransferError extends Error {
  constructor() { super("Git object transfer could not be verified."); this.name = "GitObjectTransferError"; }
}
function reject(): never { throw new GitObjectTransferError(); }
const oidPattern = /^[0-9a-f]{40}$/;
function oid(value: unknown): value is string { return typeof value === "string" && oidPattern.test(value); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) return reject();
  return value as Record<string, unknown>;
}
function utf8(content: Buffer): string {
  const value = content.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(content)) return reject();
  return value;
}
function validPath(value: string): boolean {
  return validGitPath(value) && value.split("/").every(part => {
    const lower = part.toLowerCase();
    return Buffer.byteLength(part, "utf8") <= 255 && !lower.startsWith(".git") && !lower.startsWith(".env") &&
      !["credential", "credentials", "secret", "secrets"].includes(lower) && !lower.endsWith(".pem") && !lower.endsWith(".key");
  });
}
export function gitObjectId(type: GitTransferObjectType, content: Uint8Array): string {
  if (!["commit", "tree", "blob"].includes(type)) return reject();
  return createHash("sha1").update(`${type} ${content.byteLength}\0`, "ascii").update(content).digest("hex");
}
function identity(value: string): GitTransferIdentity {
  const match = /^([^<>\x00-\x1f\x7f]+) <([^<>\s\x00-\x1f\x7f]+)> ([1-9][0-9]{0,11}) \+0000$/.exec(value);
  if (!match || Buffer.byteLength(match[1]) > 256 || Buffer.byteLength(match[2]) > 254 ||
      match[1] !== match[1].trim() || !/^[\x21-\x7e]+@[\x21-\x7e]+$/.test(match[2])) return reject();
  const timestamp = Number(match[3]);
  if (!Number.isSafeInteger(timestamp) || timestamp > 253402300799) return reject();
  const date = new Date(timestamp * 1000).toISOString();
  return Object.freeze({ name: match[1], email: match[2], timestamp, date });
}
export function serializeGitCommit(value: GitTransferCommitFields): Buffer {
  if (!oid(value.tree) || !oid(value.parent) || typeof value.message !== "string" || value.message.includes("\0") ||
      Buffer.from(value.message, "utf8").toString("utf8") !== value.message) return reject();
  const format = (person: GitTransferIdentity) => {
    const text = `${person.name} <${person.email}> ${person.timestamp} +0000`;
    const parsed = identity(text);
    if (parsed.date !== person.date) return reject();
    return text;
  };
  return Buffer.from(`tree ${value.tree}\nparent ${value.parent}\nauthor ${format(value.author)}\ncommitter ${format(value.committer)}\n\n${value.message}`, "utf8");
}
function parseCommit(objectId: string, content: Buffer): ValidatedGitCommit {
  const text = utf8(content);
  const match = /^tree ([0-9a-f]{40})\nparent ([0-9a-f]{40})\nauthor ([^\n]+)\ncommitter ([^\n]+)\n\n([\s\S]*)$/.exec(text);
  if (!match || match[5].includes("\0")) return reject();
  const fields = { tree: match[1], parent: match[2], author: identity(match[3]), committer: identity(match[4]), message: match[5] };
  if (!serializeGitCommit(fields).equals(content)) return reject();
  return Object.freeze({ oid: objectId, type: "commit", content, ...fields });
}
function treeSortKey(entry: GitTransferTreeEntry): Buffer {
  return Buffer.from(`${entry.name}${entry.type === "tree" ? "/" : "\0"}`, "utf8");
}
export function serializeGitTree(entries: readonly GitTransferTreeEntry[]): Buffer {
  if (entries.length > GIT_OBJECT_TRANSFER_LIMITS.treeEntries) return reject();
  const chunks: Buffer[] = [];
  let previous: GitTransferTreeEntry | undefined;
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry || !["100644", "100755", "40000"].includes(entry.mode) || entry.type !== (entry.mode === "40000" ? "tree" : "blob") ||
        !oid(entry.oid) || !validPath(entry.name) || entry.name.includes("/") || names.has(entry.name) ||
        (previous && Buffer.compare(treeSortKey(previous), treeSortKey(entry)) >= 0)) return reject();
    names.add(entry.name); previous = entry;
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"), Buffer.from(entry.oid, "hex"));
  }
  return Buffer.concat(chunks);
}
export function parseGitTransferTree(objectId: string, content: Buffer): ValidatedGitTree {
  const entries: GitTransferTreeEntry[] = [];
  let offset = 0;
  while (offset < content.length) {
    const end = content.indexOf(0, offset);
    if (end < 0 || end + 21 > content.length || entries.length >= GIT_OBJECT_TRANSFER_LIMITS.treeEntries) return reject();
    const match = /^(100644|100755|40000) (.+)$/.exec(utf8(content.subarray(offset, end)));
    if (!match) return reject();
    const mode = match[1] as GitTransferTreeEntry["mode"];
    entries.push(Object.freeze({ mode, name: match[2], oid: content.subarray(end + 1, end + 21).toString("hex"), type: mode === "40000" ? "tree" : "blob" }));
    offset = end + 21;
  }
  if (!serializeGitTree(entries).equals(content)) return reject();
  return Object.freeze({ oid: objectId, type: "tree", content, entries: Object.freeze(entries) });
}

/** Pure integrity validation. This never authenticates an owner or grants an
 * operation: callers must independently possess the existing execution grant. */
export function validateGitObjectTransfer(value: unknown, inputScope: GitOperationScope): ValidatedGitObjectTransfer {
  let scope: GitOperationScope;
  try { scope = validateGitOperationScope(inputScope); } catch { return reject(); }
  if (scope.operationKey !== "push" || !oid(scope.targetCommit) || !oid(scope.expectedRemoteHead) || scope.targetCommit === scope.expectedRemoteHead) return reject();
  const graph = record(value, ["version", "repositoryKey", "branch", "head", "base", "objects"]);
  if (graph.version !== 1 || graph.repositoryKey !== scope.repositoryKey || graph.branch !== scope.branch ||
      graph.head !== scope.targetCommit || graph.base !== scope.expectedRemoteHead || !Array.isArray(graph.objects) ||
      graph.objects.length < 2 || graph.objects.length > GIT_OBJECT_TRANSFER_LIMITS.objects) return reject();
  const objects = new Map<string, ValidatedGitObject>();
  let totalBytes = 0, treeEntries = 0;
  for (const item of graph.objects) {
    const wire = record(item, ["oid", "type", "contentBase64"]);
    if (!oid(wire.oid) || wire.oid === graph.base || objects.has(wire.oid) ||
        !["commit", "tree", "blob"].includes(wire.type as string) || typeof wire.contentBase64 !== "string" ||
        wire.contentBase64.length > Math.ceil(GIT_OBJECT_TRANSFER_LIMITS.objectBytes / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(wire.contentBase64)) return reject();
    const content = Buffer.from(wire.contentBase64, "base64");
    totalBytes += content.length;
    if (content.toString("base64") !== wire.contentBase64 || content.length > GIT_OBJECT_TRANSFER_LIMITS.objectBytes ||
        totalBytes > GIT_OBJECT_TRANSFER_LIMITS.totalBytes || gitObjectId(wire.type as GitTransferObjectType, content) !== wire.oid) return reject();
    const object: ValidatedGitObject = wire.type === "commit" ? parseCommit(wire.oid, content) :
      wire.type === "tree" ? parseGitTransferTree(wire.oid, content) : Object.freeze({ oid: wire.oid, type: "blob", content });
    if (object.type === "tree") treeEntries += object.entries.length;
    if (treeEntries > GIT_OBJECT_TRANSFER_LIMITS.treeEntries) return reject();
    objects.set(object.oid, object);
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > GIT_OBJECT_TRANSFER_LIMITS.encodedBytes) return reject();
  const commits: ValidatedGitCommit[] = [];
  const visited = new Set<string>();
  let cursor: string = scope.targetCommit;
  let expandedEntries = 0;
  function visitTree(objectId: string, prefix: string, depth: number): void {
    if (depth > GIT_OBJECT_TRANSFER_LIMITS.depth) return reject();
    const tree = objects.get(objectId);
    if (!tree || tree.type !== "tree") return reject();
    visited.add(tree.oid);
    for (const entry of tree.entries) {
      if (++expandedEntries > GIT_OBJECT_TRANSFER_LIMITS.treeEntries) return reject();
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!validPath(path) || Buffer.byteLength(path) > GIT_OBJECT_TRANSFER_LIMITS.pathBytes) return reject();
      const child = objects.get(entry.oid);
      if (!child || child.type !== entry.type) return reject();
      visited.add(child.oid);
      if (entry.type === "tree") visitTree(entry.oid, path, depth + 1);
    }
  }
  while (cursor !== scope.expectedRemoteHead) {
    const commit = objects.get(cursor);
    if (!commit || commit.type !== "commit" || visited.has(cursor) || commits.length >= GIT_OBJECT_TRANSFER_LIMITS.commits) return reject();
    visited.add(cursor); commits.push(commit);
    visitTree(commit.tree, "", 0);
    cursor = commit.parent;
  }
  if (objects.size !== visited.size) return reject();
  let projectCode: string;
  try { projectCode = resolveGitProjectCode(scope.repositoryKey); } catch { return reject(); }
  let lastSequence = 0;
  const orderedCommits = commits.reverse();
  for (const item of orderedCommits) {
    const match = /^([A-Z][A-Z0-9]{1,15})-([0-9]{3,9}): ([^\n]+)\n$/.exec(item.message);
    if (!match || match[1] !== projectCode || !GIT_PULL_CATEGORIES.some(category => category === match[3])) return reject();
    const sequence = Number(match[2]);
    if (sequence <= lastSequence || `${formatGitPullTitle(projectCode, sequence, match[3])}\n` !== item.message) return reject();
    lastSequence = sequence;
  }
  return Object.freeze({ version: 1, repositoryKey: scope.repositoryKey, branch: scope.branch, head: scope.targetCommit,
    base: scope.expectedRemoteHead, objects, commits: Object.freeze(orderedCommits), totalBytes });
}
