import "server-only";

import { canonicalGitRepository, validGitPath, validGitRef } from "@/lib/security/git-operation-catalogue";
import {
  GIT_OBJECT_TRANSFER_LIMITS, gitObjectId, parseGitTransferTree,
  type GitTransferIdentity, type GitTransferObjectType, type ValidatedGitBlob, type ValidatedGitTree,
} from "@/lib/security/git-object-transfer";

/** Initialization has no external ancestry anchor: every ancestor, tree and
 * blob must be present, all the way to the root commit. These limits deliberately
 * exclude larger repositories instead of silently creating shallow history. */
export const GIT_REPOSITORY_INITIALIZATION_LIMITS = GIT_OBJECT_TRANSFER_LIMITS;
export type RepositoryInitializationBinding = Readonly<{ repositoryKey: string; branch: string; head: string }>;
export type RepositoryCommitFields = Readonly<{
  tree: string; parent: string | null; author: GitTransferIdentity; committer: GitTransferIdentity; message: string;
}>;
export type ValidatedRepositoryCommit = RepositoryCommitFields & Readonly<{ oid: string; type: "commit"; content: Buffer }>;
export type ValidatedRepositoryObject = ValidatedRepositoryCommit | ValidatedGitTree | ValidatedGitBlob;
export type ValidatedRepositoryInitialization = RepositoryInitializationBinding & Readonly<{
  version: 1; objects: ReadonlyMap<string, ValidatedRepositoryObject>;
  /** Complete ancestry, oldest first, including the root. */
  commits: readonly ValidatedRepositoryCommit[]; totalBytes: number;
}>;
export type RepositoryInitializationWire = RepositoryInitializationBinding & Readonly<{
  version: 1; objects: readonly Readonly<{ oid: string; type: GitTransferObjectType; contentBase64: string }>[];
}>;

export class RepositoryInitializationIntegrityError extends Error {
  constructor() { super("Repository initialization could not be verified."); this.name = "RepositoryInitializationIntegrityError"; }
}
function reject(): never { throw new RepositoryInitializationIntegrityError(); }
function oid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{40}$/.test(value); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) return reject();
  return value as Record<string, unknown>;
}
function utf8(content: Buffer): string {
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) return reject();
  return text;
}
function identity(value: string): GitTransferIdentity {
  const match = /^([^<>\x00-\x1f\x7f]+) <([^<>\s\x00-\x1f\x7f]+)> ([1-9][0-9]{0,11}) \+0000$/.exec(value);
  if (!match || Buffer.byteLength(match[1]) > 256 || Buffer.byteLength(match[2]) > 254 ||
      match[1] !== match[1].trim() || !/^[\x21-\x7e]+@[\x21-\x7e]+$/.test(match[2])) return reject();
  const timestamp = Number(match[3]);
  if (!Number.isSafeInteger(timestamp) || timestamp > 253402300799) return reject();
  return Object.freeze({ name: match[1], email: match[2], timestamp, date: new Date(timestamp * 1000).toISOString() });
}

/** GitHub structured commits are accepted only when these exact bytes reproduce
 * their SHA. Original messages are retained; initialization never renames history. */
export function serializeRepositoryCommit(value: RepositoryCommitFields): Buffer {
  if (!value || !oid(value.tree) || (value.parent !== null && !oid(value.parent)) || typeof value.message !== "string" ||
      value.message.includes("\0") || Buffer.from(value.message, "utf8").toString("utf8") !== value.message) return reject();
  const format = (person: GitTransferIdentity): string => {
    if (!person) return reject();
    const text = `${person.name} <${person.email}> ${person.timestamp} +0000`;
    const parsed = identity(text);
    if (parsed.date !== person.date) return reject();
    return text;
  };
  const bytes = Buffer.from(`tree ${value.tree}\n${value.parent === null ? "" : `parent ${value.parent}\n`}author ${format(value.author)}\ncommitter ${format(value.committer)}\n\n${value.message}`, "utf8");
  if (bytes.length > GIT_REPOSITORY_INITIALIZATION_LIMITS.objectBytes) return reject();
  return bytes;
}
export function parseRepositoryCommit(objectId: string, content: Buffer): ValidatedRepositoryCommit {
  if (!oid(objectId) || content.length > GIT_REPOSITORY_INITIALIZATION_LIMITS.objectBytes || gitObjectId("commit", content) !== objectId) return reject();
  const match = /^tree ([0-9a-f]{40})\n(?:parent ([0-9a-f]{40})\n)?author ([^\n]+)\ncommitter ([^\n]+)\n\n([\s\S]*)$/.exec(utf8(content));
  if (!match || match[5].includes("\0")) return reject();
  const fields: RepositoryCommitFields = {
    tree: match[1], parent: match[2] ?? null, author: identity(match[3]), committer: identity(match[4]), message: match[5],
  };
  if (!serializeRepositoryCommit(fields).equals(content)) return reject();
  return Object.freeze({ oid: objectId, type: "commit", content, ...fields });
}

export function validateRepositoryInitializationBinding(value: unknown): RepositoryInitializationBinding {
  const binding = record(value, ["repositoryKey", "branch", "head"]);
  if (typeof binding.repositoryKey !== "string" || binding.repositoryKey.length > 140 || typeof binding.branch !== "string" ||
      !validGitRef(binding.branch) || !oid(binding.head)) return reject();
  try {
    if (canonicalGitRepository(`https://github.com/${binding.repositoryKey}`).key !== binding.repositoryKey) return reject();
  } catch { return reject(); }
  return Object.freeze({ repositoryKey: binding.repositoryKey, branch: binding.branch, head: binding.head });
}

/** Integrity only, never an authorization capability. The lifecycle service must
 * authenticate, approve, reserve and revalidate the exact registered sandbox. */
export function validateRepositoryInitialization(value: unknown, inputBinding: RepositoryInitializationBinding): ValidatedRepositoryInitialization {
  const binding = validateRepositoryInitializationBinding(inputBinding);
  const graph = record(value, ["version", "repositoryKey", "branch", "head", "objects"]);
  if (graph.version !== 1 || graph.repositoryKey !== binding.repositoryKey || graph.branch !== binding.branch || graph.head !== binding.head ||
      !Array.isArray(graph.objects) || graph.objects.length < 2 || graph.objects.length > GIT_REPOSITORY_INITIALIZATION_LIMITS.objects) return reject();
  const objects = new Map<string, ValidatedRepositoryObject>();
  let totalBytes = 0, treeEntries = 0;
  for (const item of graph.objects) {
    const wire = record(item, ["oid", "type", "contentBase64"]);
    if (!oid(wire.oid) || objects.has(wire.oid) || !["commit", "tree", "blob"].includes(wire.type as string) ||
        typeof wire.contentBase64 !== "string" || wire.contentBase64.length > Math.ceil(GIT_REPOSITORY_INITIALIZATION_LIMITS.objectBytes / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(wire.contentBase64)) return reject();
    const content = Buffer.from(wire.contentBase64, "base64");
    totalBytes += content.length;
    if (content.toString("base64") !== wire.contentBase64 || content.length > GIT_REPOSITORY_INITIALIZATION_LIMITS.objectBytes ||
        totalBytes > GIT_REPOSITORY_INITIALIZATION_LIMITS.totalBytes || gitObjectId(wire.type as GitTransferObjectType, content) !== wire.oid) return reject();
    let object: ValidatedRepositoryObject;
    try {
      object = wire.type === "commit" ? parseRepositoryCommit(wire.oid, content) :
        wire.type === "tree" ? parseGitTransferTree(wire.oid, content) : Object.freeze({ oid: wire.oid, type: "blob", content });
    } catch { return reject(); }
    if (object.type === "tree") treeEntries += object.entries.length;
    if (treeEntries > GIT_REPOSITORY_INITIALIZATION_LIMITS.treeEntries) return reject();
    objects.set(object.oid, object);
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > GIT_REPOSITORY_INITIALIZATION_LIMITS.encodedBytes) return reject();
  const commits: ValidatedRepositoryCommit[] = [], visited = new Set<string>();
  let cursor: string | null = binding.head, expandedEntries = 0, checkoutBytes = 0;
  function visitTree(objectId: string, prefix: string, depth: number, checkout: boolean): void {
    if (depth > GIT_REPOSITORY_INITIALIZATION_LIMITS.depth) return reject();
    const tree = objects.get(objectId);
    if (!tree || tree.type !== "tree") return reject();
    visited.add(tree.oid);
    for (const entry of tree.entries) {
      if (++expandedEntries > GIT_REPOSITORY_INITIALIZATION_LIMITS.treeEntries) return reject();
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!validGitPath(path) || path.split("/").some(part => part.toLowerCase() === ".config") ||
          Buffer.byteLength(path) > GIT_REPOSITORY_INITIALIZATION_LIMITS.pathBytes) return reject();
      const child = objects.get(entry.oid);
      if (!child || child.type !== entry.type) return reject();
      visited.add(child.oid);
      if (entry.type === "tree") visitTree(entry.oid, path, depth + 1, checkout);
      else if (checkout) {
        // Distinct paths can reference the same blob. Bound materialized HEAD
        // bytes independently of the deduplicated object graph before creation.
        checkoutBytes += child.content.length;
        if (checkoutBytes > GIT_REPOSITORY_INITIALIZATION_LIMITS.totalBytes) return reject();
      }
    }
  }
  while (cursor !== null) {
    const commit = objects.get(cursor);
    if (!commit || commit.type !== "commit" || visited.has(cursor) || commits.length >= GIT_REPOSITORY_INITIALIZATION_LIMITS.commits) return reject();
    visited.add(cursor); commits.push(commit);
    visitTree(commit.tree, "", 0, cursor === binding.head); cursor = commit.parent;
  }
  if (objects.size !== visited.size) return reject();
  return Object.freeze({ version: 1, ...binding, objects, commits: Object.freeze(commits.reverse()), totalBytes });
}
