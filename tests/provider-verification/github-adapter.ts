import { createHash } from "node:crypto";
import { consumeOfflineOperation } from "./budget";

export type SyntheticGitObject = { oid: string; type: "commit" | "tree" | "blob"; contentBase64: string };
type Person = { name: string; email: string; date: string };
type TreeEntry = { path: string; mode: string; type: "tree" | "blob"; sha: string };
type SyntheticGithubCall = { method: string; path: string; body: unknown };
export const OFFLINE_GITHUB_CREDENTIAL = "synthetic_provider_verification_only";
export type OfflineGithubFault = "none" | "wrong-repository" | "lost-branch-acknowledgment" | "wrong-object-identity";

/** Controlled REST fixture backed by real Git object bytes. This models the
 * documented Git Database JSON shapes, not live GitHub normalization or storage. */
export function createOfflineGithubAdapter(input: {
  repositoryKey: "cr8or-verification/pilot-fixture"; branch: "pilot"; head: string; objects: SyntheticGitObject[];
}) {
  if (input.repositoryKey !== "cr8or-verification/pilot-fixture" || input.branch !== "pilot") throw new Error("Offline fixture binding rejected.");
  let fault: OfflineGithubFault = "none";
  let credentialChecks = 0;
  const objects = new Map(input.objects.map(object => [object.oid, object]));
  const calls: SyntheticGithubCall[] = [];
  let head = input.head;
  const store = (type: SyntheticGitObject["type"], bytes: Buffer) => {
    const oid = createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
    objects.set(oid, { oid, type, contentBase64: bytes.toString("base64") });
    return oid;
  };
  const person = (text: string): Person => {
    const match = /^(.+) <([^<>]+)> (\d+) \+0000$/.exec(text);
    if (!match) throw new Error("Unsupported synthetic identity.");
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString().replace(".000Z", "Z") };
  };
  const personLine = (value: Person) => `${value.name} <${value.email}> ${Date.parse(value.date) / 1000} +0000`;
  const treeEntries = (bytes: Buffer): TreeEntry[] => {
    const entries: TreeEntry[] = [];
    for (let index = 0; index < bytes.length;) {
      const space = bytes.indexOf(32, index), zero = bytes.indexOf(0, space + 1);
      const mode = bytes.subarray(index, space).toString();
      entries.push({ path: bytes.subarray(space + 1, zero).toString(), mode: mode === "40000" ? "040000" : mode,
        type: mode === "40000" ? "tree" : "blob", sha: bytes.subarray(zero + 1, zero + 21).toString("hex") });
      index = zero + 21;
    }
    return entries;
  };
  const represent = (oid: string) => {
    const object = objects.get(oid);
    if (!object) return undefined;
    const bytes = Buffer.from(object.contentBase64, "base64");
    if (object.type === "blob") return { sha: oid, encoding: "base64", size: bytes.length, content: object.contentBase64 };
    if (object.type === "tree") return { sha: oid, tree: treeEntries(bytes), truncated: false };
    const text = bytes.toString(), boundary = text.indexOf("\n\n"), lines = text.slice(0, boundary).split("\n");
    return { sha: oid, tree: { sha: lines[0].slice(5) }, parents: lines.filter(line => line.startsWith("parent ")).map(line => ({ sha: line.slice(7) })),
      author: person(lines.find(line => line.startsWith("author "))!.slice(7)),
      committer: person(lines.find(line => line.startsWith("committer "))!.slice(10)), message: text.slice(boundary + 2),
      verification: { verified: false, reason: "unsigned", signature: null, payload: null } };
  };
  const ref = () => ({ ref: `refs/heads/${input.branch}`, object: { type: "commit", sha: head } });
  const fetcher: typeof fetch = async (url, init) => {
    consumeOfflineOperation();
    if (new Headers(init?.headers).get("Authorization") !== `Bearer ${OFFLINE_GITHUB_CREDENTIAL}`) throw new Error("Offline credential rejected.");
    credentialChecks++;
    const target = new URL(String(url));
    const prefix = `/repos/${input.repositoryKey}`;
    if (target.origin !== "https://api.github.com" || (target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`))) {
      throw new Error("Cross-repository synthetic request rejected.");
    }
    const suffix = target.pathname.slice(prefix.length), method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const call = { method, path: suffix, body };
    calls.push(call);
    let response: unknown;
    let status = 200;
    if (method === "GET" && suffix === "") response = { full_name: fault === "wrong-repository" ? "unrelated/synthetic-fixture" : input.repositoryKey, private: true, default_branch: input.branch };
    else if (method === "GET" && suffix === `/git/ref/heads/${input.branch}`) response = ref();
    else if (method === "GET" && /^\/git\/(commits|trees|blobs)\/[a-f0-9]{40}$/.test(suffix)) {
      response = represent(suffix.split("/").at(-1)!);
      if (!response) { response = { message: "Synthetic object missing." }; status = 404; }
    } else if (method === "GET" && suffix.startsWith("/compare/")) {
      const [base, target] = suffix.slice("/compare/".length).split("...");
      if (!objects.has(base) || !objects.has(target)) throw new Error("Synthetic compare missing an object.");
      let ancestor = target;
      const visited = new Set<string>();
      while (ancestor !== base && !visited.has(ancestor)) {
        visited.add(ancestor);
        const object = objects.get(ancestor);
        if (object?.type !== "commit") break;
        const parent = /^parent ([a-f0-9]{40})$/m.exec(Buffer.from(object.contentBase64, "base64").toString());
        if (!parent) break;
        ancestor = parent[1];
      }
      response = { status: (ancestor === base ? target === base ? "identical" : "ahead" : "diverged"),
        merge_base_commit: { sha: ancestor === base ? base : "0".repeat(40) } };
    } else if (method === "POST" && suffix === "/git/blobs") {
      if (body.encoding !== "base64") throw new Error("Unexpected synthetic blob encoding.");
      response = { sha: store("blob", Buffer.from(body.content, "base64")) };
    } else if (method === "POST" && suffix === "/git/trees") {
      const entries = [...body.tree] as TreeEntry[];
      if (entries.some(entry => objects.get(entry.sha)?.type !== entry.type)) throw new Error("Synthetic tree dependency missing.");
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.path + (a.type === "tree" ? "/" : "")), Buffer.from(b.path + (b.type === "tree" ? "/" : ""))));
      const raw = Buffer.concat(entries.map(entry => Buffer.concat([
        Buffer.from(`${entry.mode === "040000" ? "40000" : entry.mode} ${entry.path}\0`), Buffer.from(entry.sha, "hex"),
      ])));
      response = { sha: store("tree", raw) };
    } else if (method === "POST" && suffix === "/git/commits") {
      if (objects.get(body.tree)?.type !== "tree" || body.parents.some((parent: string) => objects.get(parent)?.type !== "commit")) {
        throw new Error("Synthetic commit dependency missing.");
      }
      const raw = `tree ${body.tree}\n${body.parents.map((parent: string) => `parent ${parent}\n`).join("")}author ${personLine(body.author)}\ncommitter ${personLine(body.committer)}\n\n${body.message}`;
      response = { sha: store("commit", Buffer.from(raw)) };
    } else if (method === "PATCH" && suffix === `/git/refs/heads/${input.branch}`) {
      if (body.force !== false || !objects.has(body.sha)) throw new Error("Invalid synthetic branch mutation.");
      let ancestor = body.sha;
      const visited = new Set<string>();
      while (ancestor !== head && !visited.has(ancestor) && visited.size < 128) {
        visited.add(ancestor);
        const candidate = objects.get(ancestor);
        if (candidate?.type !== "commit") break;
        const parent = /^parent ([a-f0-9]{40})$/m.exec(Buffer.from(candidate.contentBase64, "base64").toString());
        if (!parent) break;
        ancestor = parent[1];
      }
      if (ancestor !== head) throw new Error("Synthetic non-fast-forward mutation rejected.");
      head = body.sha;
      response = ref();
    } else throw new Error(`Unexpected synthetic request: ${method} ${suffix}`);
    if (fault === "wrong-object-identity" && method === "POST") response = { sha: "0".repeat(40) };
    if (fault === "lost-branch-acknowledgment" && method === "PATCH") throw new Error("Synthetic response interrupted.");
    return new Response(JSON.stringify(response), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetcher, get head() { return head; }, setFault: (value: OfflineGithubFault) => { fault = value; },
    hasExactObject: (object: SyntheticGitObject) => {
      const stored = objects.get(object.oid);
      return stored?.type === object.type && stored.contentBase64 === object.contentBase64;
    },
    evidence: () => ({ operations: calls.length, credentialChecks,
      mutations: calls.filter(call => call.method !== "GET").length,
      branchUpdates: calls.filter(call => call.method === "PATCH").length,
      objectCount: objects.size }),
  };
}
