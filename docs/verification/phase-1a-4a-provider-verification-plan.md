# Phase 1A-4A: isolated provider verification plan

**Preparation only. NO LIVE PROVIDER TESTS PERFORMED.** Every future provider test
is **NOT RUN**. This document does not authorize resource creation, credential
provisioning, database migration, live execution, deployment or release changes.

## Baseline and document set

Prepared against PR #11, `cr8or-017-repository-initialization-safeguards`, commit
`b7921efc49dcb02ceeada892e6333d3bbd711251`. Installed interfaces inspected:
`@daytona/sdk` **0.214.0**, Prisma **6.19.3**, Next.js **15.5.22**, Node.js
**24.19.0**. Recheck the exact lockfile, application SHA, SDK, snapshot and provider
API behavior before a future run; a changed baseline requires a reviewed delta.
The known GitHub Actions account restriction is not a failed code test and is
not investigated here.

| Document | Purpose |
| --- | --- |
| [Test matrix](phase-1a-4a-test-matrix.md) | Capability cases, prerequisites, procedures, evidence and NOT RUN ledger |
| [Resource authorization](phase-1a-4a-resource-authorization.md) | Separate owner approval, credentials, resource/cost ceilings and disposal |
| [Recovery runbook](phase-1a-4a-recovery-runbook.md) | Ambiguity, inspection-only reconciliation and escalation |
| [Release readiness](phase-1a-4a-release-readiness.md) | Acceptance blockers and separate release-review requirements |

This plan includes SDK/FS/ISO assumption tests; the test matrix incorporates them
by reference and defines the remaining capability tests. Each case needs its own
evidence record, including each listed variant. Preparation does not turn a
controlled-adapter test into evidence of live provider compatibility.

## Architecture under verification

| Capability | Actual implementation and boundary |
| --- | --- |
| Authentication/authorization | [execution-context.ts](../../src/lib/security/execution-context.ts), [session-store.ts](../../src/lib/security/session-store.ts), [authorized-runtime.ts](../../src/lib/workspace/authorized-runtime.ts): PostgreSQL-backed owner session and canonical project/workspace binding; revalidation before sensitive steps; no client-created execution capability |
| File writes | [private-cloud-write-session.ts](../../src/lib/workspace/private-cloud-write-session.ts), [private-cloud-write-program.ts](../../src/lib/workspace/private-cloud-write-program.ts): fixed Python helper, framed session input, staged file, SHA-256 and session recheck before COMMIT, descriptor-relative atomic replacement |
| Commands | [command-catalogue.ts](../../src/lib/security/command-catalogue.ts), [command-authorization.ts](../../src/lib/security/command-authorization.ts), [private-cloud-command-session.ts](../../src/lib/workspace/private-cloud-command-session.ts), [private-cloud-command-program.ts](../../src/lib/workspace/private-cloud-command-program.ts): exact command catalogue, opaque scoped grant, durable reservation, fixed supervisor and bounded untrusted npm code |
| Git and push | [private-git-operations.ts](../../src/lib/workspace/private-git-operations.ts), [private-git-session.ts](../../src/lib/workspace/private-git-session.ts), [private-git-program.ts](../../src/lib/workspace/private-git-program.ts), [private-github-api.ts](../../src/lib/workspace/private-github-api.ts): exact repository/branch/state, fixed operations, approval and one-shot mutation coordination |
| Object transfer | [git-object-transfer.ts](../../src/lib/security/git-object-transfer.ts), [private-github-object-transfer.ts](../../src/lib/workspace/private-github-object-transfer.ts): raw-object export and independent hashes; server-side GitHub blob/tree/commit creation and GET verification before non-force ref advance |
| Lifecycle | [private-workspace-lifecycle.ts](../../src/lib/workspace/private-workspace-lifecycle.ts), [private-lifecycle-provider.ts](../../src/lib/workspace/private-lifecycle-provider.ts), [workspace-lifecycle-store.ts](../../src/lib/security/workspace-lifecycle-store.ts): approved scope → durable reservation → exact resource → verification → registration; UNKNOWN retains identity |
| Initialization | [private-github-repository-source.ts](../../src/lib/workspace/private-github-repository-source.ts), [git-repository-initialization.ts](../../src/lib/security/git-repository-initialization.ts), [private-repository-initialization.ts](../../src/lib/workspace/private-repository-initialization.ts), [private-repository-session.ts](../../src/lib/workspace/private-repository-session.ts), [private-repository-program.ts](../../src/lib/workspace/private-repository-program.ts): complete supported Git graph retrieved on server, framed input, independent validation, no-replace repository publication and second inspection before registration |

The trust flow is authenticated owner → registered/reserved identity → exact
approved operation → shared PostgreSQL coordination → verified provider resource
→ bounded transport → independent result verification. Tokens remain on the
application server. Fixed helper source is allowed in command arguments; private
file/object bytes, authentication tokens and GitHub credentials are not.
Base64 is encoding, not confidentiality. Both providers can observe data submitted
to their control planes. Echo suppression cannot establish provider secrecy.

Balanced/strict policies require the existing one-time, ten-minute scoped
approvals for high-risk operations. Approval binds owner, initiating session,
credential generation and exact operation targets. Autonomous mode intentionally
waives human approval, not authentication, identity, coordination or release
restrictions. Revocation stops subsequent steps; it cannot reverse a completed
external mutation or make a database check and a remote commit atomic.

## Hardcoded restrictions and future harness dependency

These files are unchanged and must remain unchanged during isolated verification:

- [private-cloud-write-availability.ts](../../src/lib/workspace/private-cloud-write-availability.ts)
- [private-cloud-command-availability.ts](../../src/lib/workspace/private-cloud-command-availability.ts)
- [private-git-availability.ts](../../src/lib/workspace/private-git-availability.ts)
- [private-workspace-lifecycle-availability.ts](../../src/lib/workspace/private-workspace-lifecycle-availability.ts), including the separate cloning assertion

No live harness is supplied. A **later, separately authorized assignment** must
implement and review a test-only runner that composes existing server-only
mechanisms with real provider adapters and genuine isolated database sessions.
It must be outside deployed request paths, accept only an approved inventory,
deny production identifiers and use a bounded operation manifest. It must not
edit gates, accept arbitrary adapters/roles from HTTP or models, introduce an
environment-variable release switch, or replace authentication with a stub.
Existing offline tests may replace gates in their test runner; that is not a
recipe for altering deployed code or sufficient evidence for live verification.

An additional concrete dependency is [git-project-naming.ts](../../src/lib/security/git-project-naming.ts):
the current trusted mapping contains only `badadeveloper001-dev/cr8or-studio`.
Tests must **never** use that application repository as the disposable target.
A reviewed test-only trusted mapping/composition for the exact disposable
repository is necessary for real helper-created numbered commits and PRs.
Request-supplied codes, forged repository keys and guessed sequence numbers are
not substitutes. This preparation does not add that mapping.

## Reproducible fixture contract

Record a fixture manifest before any future upload: fixture version, synthetic
repository identity, branch, canonical origin, exact Git object-format, every
object ID/type/byte length, complete ordered commit ancestry, file SHA-256s and
expected HEAD. Keep synthetic fixture content in a restricted local artifact;
publish only hashes/counts and safe names in evidence. No customer/private source.

The minimal positive repository is SHA-1, branch `verification-main`, two
unsigned zero/one-parent commits with explicit synthetic author/committer,
whole-second UTC dates, UTF-8 messages and no extra headers. It contains
`README.txt` with ASCII and LF/CRLF variants, `unicode-雪.txt` with composed and
decomposed Unicode plus an emoji, `empty.txt` with zero bytes, `binary.dat` with
bytes 0..255, and a dependency-free `package.json`. Its five exact catalogue
scripts run small local Node fixtures; no install/network is needed in Daytona.
No `.gitignore`, `.github`, `.gitattributes`, `.config`, secret files, symlinks,
submodules, signatures or merge commits belong in this positive fixture.

Use separate versioned local fixture variants for malicious paths, unsupported
modes, 17-commit history, merges, signatures, missing parents, wrong repository,
over-limit graphs and output/process-limit behavior. Never mutate the positive
fixture in place or upload an unsupported variant as a successful initialization.
For live source-download rejection cases, explicitly budget each disposable
branch/repository variant and bind it to a fresh intended operation. A local
tampered-response adapter tests the rejection logic, not actual GitHub corruption.
Missing object ancestry and SHA-256 Git repositories must use controlled source
response/offline variants if GitHub cannot host them; never claim a live GitHub
format test from an injected graph. Real supported GitHub fixtures supply the
17-commit, merge and signed-history rejection cases where representable.

Future supported push cycles must create commits with the **actual fixed Git
helper**, trusted test project code and allowed neutral categories. Save the
pre/post HEAD and ordered history. Transfer those actual objects to the disposable
GitHub repository, compare all SHA identities, then test the approved draft PR
workflow. Repeat a second cycle without manually inventing a prefixed commit.
Commit and corresponding PR share the change identifier; stale approved titles
require a fresh approval, never silent renumbering. The manifest must allocate
non-conflicting PR branch pairs: keep the registered source `verification-main`
and separately approve creation of `verification-base-1` and
`verification-base-2` at the fixture root. Cycle one targets base-1; cycle two
targets base-2, with each exact base SHA approved. The second push also advances
the first open PR's head; include that expected effect in the reviewed test scope
and retain its original creation evidence. Never silently close, recreate or merge
that PR to permit another identical head/base pair. This uses existing structured
branch creation and keeps the local registered source branch unchanged.

Use the existing local tests as reference implementations, not live evidence:
[private-cloud-write-program.test.ts](../../tests/unit/private-cloud-write-program.test.ts),
[private-cloud-command-program.test.ts](../../tests/unit/private-cloud-command-program.test.ts),
[private-git-transfer-integration.test.ts](../../tests/unit/private-git-transfer-integration.test.ts),
[private-repository-initialization.test.ts](../../tests/unit/private-repository-initialization.test.ts),
[workspace-lifecycle.test.ts](../../tests/integration/workspace-lifecycle.test.ts).
The controlled session adapter runs real Python locally; it does not reproduce
Daytona's PTY/proxy/logging or resource boundaries.

## Execution order after separate authorization

1. **Freeze and authorize.** Review the runner, fixture hashes, exact resource
   inventory, dedicated credential permissions, maximum spend, approved duration,
   cleanup scope and evidence retention. Missing approval means NOT RUN. Confirm
   no production connectivity and no owner workspace identifiers. Re-run relevant
   existing automated suites on Node 24 in isolated infrastructure; keep those
   results separate from provider results.
2. **Establish baseline resources.** Create only the approved disposable resources
   through the reviewed future setup path. Record exact IDs, snapshot digest,
   region, labels and DB registrations. Lifecycle creation under test must retain
   its own reservation flow; setup must not pre-register a fabricated successful
   outcome. Test creation once, then inspect before any execution.
3. **Verify assumptions first.** Execute SDK/FS/ISO probes below with synthetic
   canaries. Establish the shared repository directory, trusted binaries, UID,
   mounted-volume absence, runtime network controls, process boundaries and
   no-replace primitive. Stop dependent tests on FAIL or INCONCLUSIVE. A matching
   metadata flag is insufficient for runtime isolation.
4. **Verify lifecycle and authorization.** Use separate create/start/stop scopes,
   actual disposable PostgreSQL and two runner processes for cross-instance
   races. Confirm reads never start/recreate anything. Test unsafe metadata using
   controlled responses; never make a live sandbox insecure merely to obtain a
   negative result. Distinguish this injected test from live provider evidence.
5. **Initialize the positive repository.** Exercise actual GitHub GETs and actual
   Daytona framed input through the trusted lifecycle path. Verify complete
   history, exact objects, branch, clean worktree, origin, marker, no-replace
   publication, independent inspection and final DB association. Gate-dependent
   operations remain available only to the reviewed isolated runner.
6. **Exercise writes and bounded commands.** Record destination hashes before
   each write; exercise both direct-runtime and agent write paths. Use one
   approved benign command at a time before adversarial resource/child-process
   fixtures. Do not execute hostile fixture code until isolation and separately
   authorized stop/cleanup are established. Verify actual process disappearance,
   not just session deletion, with independently observed bounded canaries.
7. **Exercise Git and object upload.** Use real helper-created commits and actual
   GitHub Git Database responses; fetch and reconstruct every object independently.
   Confirm exact remote ref and non-force behavior. Test draft PR title/status
   invariants only in the approved disposable repo. No merge, deploy or production
   repository changes. Race/fault scenarios are separate explicitly bounded runs.
8. **Inject failures at named checkpoints.** Before dispatch, after provider
   dispatch, after STAGED/before COMMIT, after object POST/before ref PATCH and
   after publication/before acknowledgment. A fault adapter may drop a real
   provider response but must not fabricate a live success. Record which boundary
   was injected and which external effect was actually observed. Never repeat a
   mutation to find out whether it happened. Follow the recovery runbook.
9. **Inspect and clean up within approval.** Inventory every created resource,
   session, branch and temporary path. Preserve unresolved evidence. Do not clear
   UNKNOWN records, delete resources or revoke credentials outside the approved
   cleanup scope. Confirm removal/stoppage independently and retain unresolved
   cleanup as an open blocker. Stop at the time/spend ceiling even if tests remain.
10. **Review evidence.** Dependent cases not executed remain NOT RUN. An
    attempted case with missing evidence is INCONCLUSIVE; an observed invariant
    violation is FAIL. Issue a provider report, not an automatic release. Any gate change requires a separate reviewed implementation and
    explicit owner authorization.

## Implementation limits to preserve

These are code ceilings, not permission to spend up to them. The resource
authorization checklist imposes a smaller total-run budget. Phase durations are
nested ceilings, not additive allowances. Check source constants again at run time.

| Mechanism | Current bound and meaning |
| --- | --- |
| Private file API | 2 MiB request body; 4 KiB relative path; 256 KiB UTF-8 write/read; no silent truncation |
| File read/list | 2 MiB output; 200 listed entries/4,096 scanned entries; helper 30 s/local wait 35 s |
| File write | 12 KiB input chunks; 4 KiB output; 35 s session; 5 s SDK/cleanup; 160 polls at 100 ms |
| Commands | Exact five npm commands; 60 s command, 10 s handshake, 80 s session, 5 s SDK/cleanup; 64 KiB combined returned output/512 KiB protocol; 16 MiB per generated file; 64 process UID limit/128 open descriptors/core dumps disabled; no per-command memory limit, so provider memory enforcement must be verified |
| Command coordination | One active per workspace; six starts per five minutes; no unbounded queue; UNKNOWN retains slot; session recheck uses a two-second elapsed-time threshold between bounded polls, plus sensitive boundaries; awaited SDK calls can extend detection latency |
| Git coordination | One active Git operation per workspace; six starts per five minutes; workspace/repository mutation locks; outer operation 45 s, session 40 s, helper 30 s, SDK/cleanup 5 s |
| Object graph | 16 new commits for push, 16 total rooted commits for initialization; 128 objects, 256 KiB/object, 1 MiB raw objects, 2 MiB wire, 512 expanded tree entries, depth 32, path 4 KiB |
| GitHub object API | 300 requests/30 s phase, 1 MiB bodies, 5 s per request/body deadline; no automatic retry or credential-bearing redirects |
| Repository initialization | Additional 1 MiB expanded HEAD checkout; 12 KiB chunks, 4 KiB output, 40 s session/1,000 SDK calls; helper 35 s/15 CPU s/256 MiB address space; Git child 10 CPU s/256 MiB/64 KiB output; 2 MiB per generated file; 2,048-entry directory scans |
| Lifecycle | 60 s outer deadline; provider phase 30 s/request 5 s; one concurrent provisioning/four pending/three creations per 15 minutes; six existing-project mutations per five minutes; reconciliation max three attempts at least 60 s apart, max two discovery matches |
| Authentication/approval | Session absolute maximum 12 h; approval ten minutes, one-time, session/generation bound; no synthetic authorization fallback |

The file API accepts UTF-8 text, not arbitrary bytes: validate exact UTF-8 bytes,
NUL where supported and CR/LF behavior without claiming an arbitrary binary write
API. Binary object integrity belongs to Git transfer/initialization. Unsupported
input must fail, never be silently normalized. The initialization subset excludes
many ordinary repositories; even `.gitignore` and `.github` are rejected by the
current sensitive-path rules. Test those as expected restrictions.

## Evidence record and result rules

Use this structure for every test and variant; no live records are populated in
this preparation. Artifact references must be access controlled and sanitized.

```json
{
  "testId": "FILE-01",
  "variant": "fixture-version-and-case",
  "capability": "private-file-write",
  "executionKind": "LIVE_PROVIDER | CONTROLLED_FAULT_WITH_LIVE_PROVIDER | OFFLINE_ADAPTER",
  "result": "NOT RUN",
  "fixtureIdentity": {"manifestSha256": null, "inventoryReference": null},
  "baseline": {"applicationSha": null, "sdk": "@daytona/sdk@0.214.0", "node": null},
  "environment": {"snapshotDigest": null, "region": null, "osKernel": null, "databaseInventoryReference": null},
  "authorizationReference": null,
  "operationReference": null,
  "startedAt": null,
  "finishedAt": null,
  "expectedBehavior": "Populate before execution",
  "observedBehavior": null,
  "sanitizedEvidence": [],
  "securityImplications": null,
  "cleanup": {"status": "NOT RUN", "inventoryReference": null, "evidence": []},
  "reviewer": null
}
```

- **PASS:** the specified invariant and required independent evidence were
  observed. Expected negative rejection is a PASS only if no prohibited side
  effect occurred. A PASS for rejection of an unsupported repository is not clone
  compatibility for that format.
- **FAIL:** an invariant was violated, an unsafe effect occurred, or sensitive
  data appeared where prohibited. Stop dependent tests and preserve sanitized
  evidence; follow the runbook.
- **INCONCLUSIVE:** outcome, isolation, cancellation or cleanup cannot be
  established, including a lost response. Never coerce UNKNOWN into success.
- **NOT RUN:** not executed, blocked by prerequisites, or outside authorization.

Record hashes, byte counts, bounded durations, safe operation/resource references,
state transitions and termination observations. Do not persist authorization
headers, cookies, raw session IDs/tokens, environment values, raw command output,
private source or full provider error bodies. Exact IDs required for operator
reconciliation live in the restricted inventory, not an unrestricted PR comment.
Synthetic canary comparisons should return presence/absence and hashes; scanner
output must not repeat a matched credential. OFFLINE_ADAPTER results never satisfy
a LIVE_PROVIDER case. Existing historical test counts are not this phase's results.

## Unresolved decisions before live work

Owner approval must name the test resources, region/snapshot, exact credential
permissions, financial ceiling, run deadline, cleanup authority and evidence
retention. The reviewed future harness and disposable-repository naming binding
are missing prerequisites. Provider pricing, account quotas, runtime isolation,
input framing/log visibility, process termination, GitHub reconstruction and Linux
publication semantics remain unverified. No assumption here authorizes production
resource inspection or historical credential remediation.

GitHub REST ref updates have no expected-old-SHA compare-and-swap parameter.
Expected-head/ancestry checks, `force: false` and final verification narrow but do
not eliminate an external writer race. Same-UID processes can escape a process
group or interfere with helpers; a working directory is not a filesystem sandbox.
Provider metadata cannot prove the snapshot is secret-free. These are explicit
release-review issues, even if benign fixture tests pass.

## Installed SDK and runtime compatibility matrix

The following rows are part of the planned test ledger. All are **NOT RUN**.

Preparation evidence only: repository source and installed `@daytona/sdk` **0.214.0**, `node_modules/@daytona/sdk/cjs/{Process,Daytona,Sandbox}.d.ts`, matching `Process.js`, and `@daytona/toolbox-api-client/src/models/{session-execute-request,session-execute-response,command}.d.ts`. SDK signatures describe transport capability; they do not attest the remote kernel, snapshot, sandbox boundary, input privacy or process termination. Every test below is **NOT RUN** and requires separate authorization and a later reviewed harness. No future procedure permits a production resource or removal of an application release gate.

Source abbreviations (all relative to repository root):

- `W`: `src/lib/workspace/private-cloud-write-session.ts` and `private-cloud-write-program.ts`.
- `F`: `src/lib/workspace/private-cloud-files.ts`.
- `C`: `src/lib/workspace/private-cloud-command-session.ts` and `private-cloud-command-program.ts`.
- `G`: `src/lib/workspace/private-git-session.ts` and `private-git-program.ts`.
- `R`: `src/lib/workspace/private-repository-session.ts` and `private-repository-program.ts`.
- `P`: `src/lib/workspace/providers/daytona.ts`, specifically `getPrivateFileSessionProcess`, `getPrivateCommandSessionProcess`, `getPrivateGitSessionProcess`.
- `L`: `src/lib/workspace/private-lifecycle-provider.ts` and `private-workspace-lifecycle.ts`.

### Session execution

| ID / status | Application assumption and implementation | Installed SDK contract | Unverified behavior | Minimum future safe test | Expected sanitized evidence / failure conditions |
| --- | --- | --- | --- | --- | --- |
| SDK-01 / NOT RUN | W/C/G/R generate a unique session ID, then create one session in the exact admitted sandbox. | `createSession(sessionId: string): Promise<void>`; `getSession`, `listSessions` available. | Creation latency, duplicate-ID behavior, lost acknowledgment, whether a late session survives local timeout. | In one approved disposable sandbox, create one bounded session with a fixed harmless handshake helper; simulate lost response in test transport, then reconcile by exact ID. | Session/sandbox IDs, timestamps, exact-ID lookup, cleanup receipt. Wrong sandbox, duplicate dispatch or unaccounted late session fails; missing evidence is INCONCLUSIVE. |
| SDK-02 / NOT RUN | W/C/G/R need asynchronous execution that returns `cmdId` before framed input. | `executeSessionCommand(sessionId, {command, runAsync:true, suppressInputEcho:true}, timeout?)`; response has `cmdId`, optional `exitCode/output/stdout/stderr`. Request also has legacy `async?`, which application does not need. | Time to return, stream readiness and whether implementation truly runs asynchronously. | Run the actual fixed helper, deliberately delay first input within its handshake budget, confirm bounded response and READY before input. | Command ID and timing-only transcript; premature synchronous wait, missing ID, unexpected executable or output fails. |
| SDK-03 / NOT RUN | Content crosses session input only; W uses sequenced Base64 frames, R uses bounded JSON/object payload chunks; exact bytes must survive. | `sendSessionCommandInput(sessionId,commandId,data:string):Promise<void>` sends JSON `{data}` via Toolbox input endpoint, not a command argument. | Chunk ordering, buffering, string encoding, disconnect/short-write behavior; no byte-stream acknowledgment contract. | Send synthetic Unicode, NUL-bearing Git blobs encoded in graph Base64, empty and maximum payloads using actual adapter framing; interrupt mid-frame. | Locally computed hashes and received byte counts, bounded failure with unchanged destination. Missing/duplicated/reordered bytes, silent truncation or content in argv fails. UTF-8 file-writing API must reject invalid UTF-8, not claim arbitrary binary writes. |
| SDK-04 / NOT RUN | `suppressInputEcho:true` and helper terminal settings prevent input from entering session output. W/C/G also configure termios when stdin is a TTY; R relies on supported SDK suppression. | Request type exposes optional boolean; default documented false. | Provider implementation, startup echo race, input retention outside session output, observability middleware. | Use unique synthetic marker strings in payloads; inspect bounded SDK logs and approved provider logging surfaces for raw and Base64 markers, retaining only match counts. | Zero marker matches in command metadata/application logs/session output. Any leak fails; unavailable provider-log visibility leaves that claim INCONCLUSIVE. Provider control plane remains trusted and can observe submitted content. |
| SDK-05 / NOT RUN | Parsers require exact READY/STAGED/RESULT framing, stdout only, bounded totals; no silent truncation. | `getSessionCommandLogs` returns optional `output/stdout/stderr`; SDK fills absent fields with `""`; callbacks use WebSocket demultiplexing. Application uses snapshot-return overload. | Whether repeated calls return cumulative full logs, prefix stability, output ordering, PTY banners/CRLF or truncation. | Poll actual helper at several stages and test one bounded excess-output fixture; never print payload. | Frame lengths, prefix hashes, parsed states; changed prefix, unexpected stderr, duplicated/truncated output or acceptance over cap fails. SDK does not offer an application-requested response-size cap; snapshot resource/output bounds remain necessary. |
| SDK-06 / NOT RUN | Success requires a terminal framed result and compatible process exit code. | `getSessionCommand(sessionId,commandId):Promise<Command>` exposes `id`, `command`, optional `exitCode`; absent exitCode need not mean successful completion. | Eventual consistency/order between final output and exit status; stale status after disconnect. | Fixed helper succeeds, fails and stalls in separate disposable cases; fetch logs/status until bounded terminal deadline. | Matching ID, bounded status progression, explicit exit code. Missing/conflicting terminal evidence cannot produce PASS or a successful operation receipt. |
| SDK-07 / NOT RUN | W/C/G/R request bounded cleanup, including best-effort cleanup after late create resolution. | `deleteSession(sessionId):Promise<void>` and `listSessions` exist; deletion documentation promises session deletion, not descendant-process termination. | Idempotency, residual processes, logs retention and late-arriving session creation. | Create then delete the test session; inspect exact session absence separately from process evidence. Inject cleanup failure and late create acknowledgment. | Separate `sessionAbsent`, `processTerminationConfirmed`, cleanup deadline and residual inventory. A resolved delete call alone is insufficient evidence of termination; an unaccounted resource remains INCONCLUSIVE. |
| SDK-08 / NOT RUN | C sends CANCEL/EOF, Python supervises process group; G/R/W signal/error paths clean staged work where possible. | General session API has no typed kill-command or AbortSignal parameter. Separate `killPtySession` targets the distinct PTY API, not a substitute for current session transport. | Surviving descendants, `setsid` escape, supervisor killed by same-UID npm script, lost cancellation input. | Run bounded synthetic script with child/grandchild and a separately labeled escaped descendant; cancel, then independently enumerate only test-owned PIDs/process groups through separately reviewed fixture instrumentation. | Confirmed individual/group termination plus remaining PID inventory. Any unconfirmed descendant keeps execution restriction; deleting a session or losing HTTP connection cannot be recorded as termination. No host-wide kill or unrelated process inspection. |
| SDK-09 / NOT RUN | Local deadlines stop scheduling and retain uncertain external outcomes; remote helper deadlines bound execution separately. | `executeSessionCommand(...,timeout)` implementation sets HTTP request timeout (`timeout*1000`). `executeCommand` separately documents server-side termination, which must not be inferred for async session commands. `Daytona({requestTimeoutMs:5000})`; start/stop accept wait seconds, no AbortSignal. | Whether provider continues after timeout; transport/body/cleanup timing; timing under load. | Delay/loss injection on approved disposable operations and observe exact remote state after local deadline without automatic mutation retries. | Clocked local return, remote terminal evidence or UNKNOWN reservation. Timeout-as-success or silent reservation release fails; elapsed local timeout does not prove remote cancellation. |

### Filesystem and executable compatibility

| ID / status | Application assumption and implementation | Installed SDK contract | Unverified behavior | Minimum future safe test | Expected sanitized evidence / failure conditions |
| --- | --- | --- | --- | --- | --- |
| FS-01 / NOT RUN | F/W/G/R open `repo` relative to session CWD; C explicitly resolves `/workspace/repo`. All must identify one registered repository. | `Sandbox.getWorkDir()` reports Dockerfile WORKDIR, otherwise user HOME; session request has no `cwd` field. No guarantee of `/workspace`. | Snapshot WORKDIR, session initial CWD and whether helpers share canonical root. | Read actual CWD and descriptor device/inode metadata through fixed fixture probe; compare with `getWorkDir` and `/workspace/repo`, before content operations. | Canonical path plus inode mapping without source content. Any mismatch blocks the affected capabilities; do not silently change destination or use caller CWD. |
| FS-02 / NOT RUN | Fixed `python3 -I -S -u -c` helper needs standard-library OS, selectors, termios, signal, resource, hashlib, ctypes, zlib APIs. | SDK executes supplied command; it does not ship or guarantee Python version/modules or interpreter ownership. | Interpreter resolution/integrity, platform functions, TTY behavior. | Reviewed snapshot inventory plus fixed import/version/feature probe; verify runtime unprivileged user and interpreter paths without reading secrets. | Python version, resolved executable ownership and feature booleans. Missing API, writable untrusted interpreter/parent or unexpected platform fails. |
| FS-03 / NOT RUN | G/R require trusted root-owned `/usr/bin/git`/parents; C accepts trusted Node/npm under `/usr` or `/usr/local`, denies group/world-writable chain. | SDK Git/process features do not attest those binaries or installed npm dependencies. | Binary versions/permissions, npm availability with blocked networking, snapshot contents. | Inventory exact binaries and hashes from reviewed snapshot; run tiny synthetic offline scripts and fixed Git verification with no network/dependency installation. | Version/hash/ownership summaries and catalogue result. Missing binary, untrusted executable, dependency download requirement or divergent Git semantics fails. |
| FS-04 / NOT RUN | Helpers need writable project parent/repository but trusted executable installation; stage files 0600/directories0700 and unprivileged execution. | SDK `user` field is configuration/metadata, not proof of filesystem ACLs or effective UID. | UID/GID, umask, owner changes, writable parents, provider mounts. | Probe effective UID and only disposable parent/root/stage permission metadata; try unauthorized sibling fixture access if separately authorized. | IDs/modes and denial results; root runtime, unexpected writable executable chain or cross-fixture access fails. |
| FS-05 / NOT RUN | `dir_fd`, O_DIRECTORY/O_NOFOLLOW/O_EXCL, fstat, fsync and descriptor-based traversal must behave as Linux helper expects. | SDK offers no guarantee for kernel/filesystem behavior; pathname upload APIs are deliberately not a fallback. | Mounted filesystem support, inode stability, fsync behavior. | In disposable root, use actual helper with nested regular files and permission failures, then verify inode/type/bytes independently. | Feature/errno summaries and integrity hashes. Unsupported flags, followed special files, permissions bypass or partial publication fails. |
| FS-06 / NOT RUN | F/W/G/R reject symlink traversal, hard-linked destinations and unsupported special files; path controls stay active. | SDK has no application containment guarantee. | Race behavior on provider filesystem, same-UID peer interference. | Disposable symlink, hardlink, FIFO, traversal and destination-substitution fixtures; compare outside-fixture sentinel hashes before/after. | Rejection codes, unchanged sentinels, no content disclosure. Any unintended read/write or hang fails. Successful cases do not prove safety against an unrestricted same-UID adversary. |
| FS-07 / NOT RUN | W stages complete UTF-8 bytes, checks SHA-256, fsyncs and atomically `os.replace`s within one directory. | SDK only transports helper; atomicity depends on actual filesystem. | Same-filesystem rename behavior, crash durability and provider snapshot/storage semantics. | Replace disposable old file; interrupt before COMMIT and during controlled publication window, observing complete old/new digest only. | Old/new digest, destination inode, staged inventory, acknowledgment state. Partial destination, changed file before commit or corrupt data fails. Lost acknowledgment after replace is uncertain, not safe to retry. |
| FS-08 / NOT RUN | R dynamically loads libc `renameat2` and fails closed if missing/unsupported. | No SDK libc/kernel guarantee. | Symbol presence and filesystem support for Linux flag 1 (RENAME_NOREPLACE). | Fixed probe in disposable sibling directories followed by actual initializer; verify unsupported-path controlled rejection offline separately. | Kernel/libc/FS feature evidence and syscall errno summary. Missing primitive or fallback to overwrite blocks initialization. |
| FS-09 / NOT RUN | R publishes complete staged repository only with `renameat2(...,RENAME_NOREPLACE)` and rechecks published inode, objects/HEAD/worktree. | SDK does not guarantee no-replace atomicity. | Concurrent destination creation, directory filesystem semantics. | Place sentinel destination immediately before publication in a disposable fixture and separately initialize absent destination; verify original identity unchanged. | Expected EEXIST/rejection and unchanged existing history; successful case exact object and inode checks. Replacing/adopting preexisting destination or reporting incomplete publication as ready fails. |
| FS-10 / NOT RUN | Own staged files/directories and temp command HOME are cleaned best effort; no historical or uncertain resource is automatically deleted. | Session cleanup is independent of filesystem cleanup; no automatic application-specific temp cleanup. | SIGKILL/disconnect remnants, cleanup permissions, fsync failures. | Interrupt each actual helper before/after staging, inventory only run-labeled temporary paths and session IDs. | Hash/size-only residual inventory and cleanup status per fixture. Unaccounted files or deletion of non-test paths fails; unconfirmed cleanup remains INCONCLUSIVE and requires approved operator action. |

### Isolation and lifecycle admission

| ID / status | Application assumption and implementation | Installed SDK contract | Unverified behavior | Minimum future safe test | Expected sanitized evidence / failure conditions |
| --- | --- | --- | --- | --- | --- |
| ISO-01 / NOT RUN | P/L require returned `id` equal registered/reserved exact ID; creation also requires owner/project/operation/registration labels. Names never establish ownership. | `Daytona.get` supports ID or name; list may omit security metadata, requiring fresh exact retrieval. | Correct lookup identity, stale metadata, labels/resource association. | Exact-ID fresh get of one approved test sandbox; use only controlled adapter negative responses for unrelated IDs unless second disposable sandbox separately authorized. | Sanitized ID/label matching and PostgreSQL reservation mapping. Alias/name-only acceptance, inconsistent ID or remapping fails. |
| ISO-02 / NOT RUN | L requires exact reviewed snapshot and target; P command/Git metadata checks do not independently pin snapshot. | Create-from-snapshot accepts snapshot name; Sandbox exposes snapshot/target; no immutable image digest attestation contract. | Snapshot mutability, image contents, runtime drift and sandbox class. | Independently approve snapshot provenance/digest/version and region, compare runtime probe inventory plus fresh metadata. | Approved artifact identity, versions and mismatch results. Name alone cannot prove immutable image; unverified provenance is a release blocker. No snapshot creation/modification authorized now. |
| ISO-03 / NOT RUN | Metadata user must be `daytona`; C rejects privileged effective execution. | Create accepts `user`; Sandbox exposes `user`. | Actual UID/GID, supplementary groups, Linux capabilities, privilege escalation pathways. | Fixed identity/capability probe in approved fixture; separately bounded safe checks for elevation denied. | Sanitized UID/group/capability summaries. Effective root, privileged capability or mismatch fails; metadata alone insufficient. |
| ISO-04 / NOT RUN | L requests envVars/secrets empty; P commands require empty `sandbox.env`; C uses constructed clean child env and temporary npm HOME. | SDK supports envVars, secrets and daemon env updates; secrets placeholders may be substituted on allowed outbound requests. Empty DTO env does not attest image/PID environment. | Snapshot secrets, inherited daemon vars, `/proc` peer visibility, telemetry retention. | Dedicated synthetic server-only canary must remain absent from argv/env/config/output; compare names and hashes/booleans only inside disposable runtime. Review provider log/telemetry configuration independently. | Zero credential/canary exposure with bounded metadata-only reports. Any reusable token in sandbox fails; cannot claim control-plane confidentiality from `suppressInputEcho`. |
| ISO-05 / NOT RUN | Working directory is scope, not a sandbox. Untrusted npm scripts can access other files available to same sandbox/user. | SDK exposes sandbox abstraction, not a proven per-command filesystem confinement guarantee. | Host/peer mounts, same-sandbox credential locations, other project visibility. | Review provider boundary documentation and approved mount/namespace probe; use synthetic sibling/peer canaries only when resources are separately approved. | Mount/namespace facts and canary denial, plus provider guarantees. Any production mount or cross-project access fails; one negative probe cannot prove universal isolation. |
| ISO-06 / NOT RUN | P/L require networkBlockAll true, no network/domain allowlist, proxy or linked sandbox. | SDK exposes network restriction metadata; proxy docs explicitly say convenience routing is not a security boundary. | Actual DNS/TCP/IPv4/IPv6/metadata egress enforcement; Toolbox reachability while sandbox egress blocked. | Bounded denied connections only to owner-approved test endpoints, never scanning production networks; verify provider enforcement and control-plane path separately. | Destination-class/result summaries, no packets with secrets. Any unauthorized egress or unverifiable restriction blocks release. Adding a test endpoint/second sandbox requires explicit resource authorization. |
| ISO-07 / NOT RUN | New resources have no mounted volumes; P/L require explicit empty array. | Volume parameters and metadata exist; list omits volume metadata. | Hidden/image/system mounts, historical credentials, network filesystems. | Fresh exact get and fixed mount inventory scoped to disposable sandbox; inspect only synthetic fixture data. | Volume IDs/absence and approved mount types. Unexpected volume/host/project mount fails; never inspect historical owner sandboxes for this test. |
| ISO-08 / NOT RUN | Supervisors and trusted helpers must not be undermined by same-UID project code; process groups/rlimits are resource controls only. | SDK sessions are background processes, not per-command security principals; no typed same-UID isolation or descendant containment guarantee. | PID namespaces/cgroups, supervisor attack, session escape, descendant cancellation. | With owner-approved bounded adversarial synthetic npm script, test parent/group escape and cancellation, then independently enumerate test-owned descendants. | Verified boundary and termination evidence, provider documentation. Unconfirmed or escapable process isolation remains blocker even when regular command tests pass. |
| ISO-09 / NOT RUN | P/L metadata requires gpu0, 0<cpu<=2, 0<memory<=4GiB, 0<disk<=10GiB; helper limits supplement provider resource isolation. | Snapshot creation resource capacity comes from reviewed snapshot; returned resource fields do not prove enforced cgroups/quotas. | Runtime CPU/memory/disk quotas, per-UID NPROC effects, aggregate temporary storage. | Verify runtime limits with bounded probes strictly below separately approved budgets; run controlled output/time/file-size excess cases, not host exhaustion. | Config/runtime comparisons, measured bounded termination and storage inventory. Missing quotas or unconstrained growth fails; avoid destructive stress. |
| ISO-10 / NOT RUN | L requests autoStop15min, autoPause0, autoDelete-1, ttl0, ephemeralfalse; validates no autoDestroyAt. Historical stop allowed only without destructive delete policy. | SDK documents auto-stop/auto-pause; negative autoDelete disables deletion, ttl0 disables wall-clock destruction, ephemeral true forces autoDelete0; stop(force=false) uses SIGTERM. | Actual stop timing, archival behavior/cost, ongoing storage cost, service-side policy. | Fresh metadata before/after explicitly approved start/stop and bounded idle observation; no forced deletion except separately approved exact-ID cleanup. | Exact state/identity/history retained and billing inventory. Unsafe auto-deletion, changed ID, unexpected restart/recreation or false ready state fails. Auto-stop does not mean cost-free or deleted. |

## Preparation-only validation results

Executed locally on Node.js **24.19.0**. These results validate documentation and
existing offline fixtures, not provider compatibility. No new fixture or harness
implementation is included; the change consists of the five Markdown documents.

| Check executed | Actual result |
| --- | --- |
| Node documentation consistency check | Passed: five documents, 91 relative file links resolved, 119 unique planned test IDs, every test NOT RUN, balanced code fences and no credential-pattern matches |
| Git scope comparison against PR #11 baseline | Passed: application code, tests, scripts, Prisma schema/migrations, package manifest/lockfile and all release restrictions unchanged |
| Git whitespace/diff integrity | Passed |
| Existing `private-git-transfer-integration.test.ts` | 18 passed; actual disposable local Git/helper plus controlled GitHub adapter |
| Existing `private-repository-initialization.test.ts` | 20 passed; actual disposable local Git/filesystem/helper plus controlled providers |
| Existing `private-lifecycle-provider.test.ts` | 166 passed; controlled provider responses |
| Combined targeted Vitest run | **204 passed in three files**, 52.49 seconds |

The exact targeted command was:

```sh
./node_modules/.bin/vitest run tests/unit/private-git-transfer-integration.test.ts tests/unit/private-repository-initialization.test.ts tests/unit/private-lifecycle-provider.test.ts --no-file-parallelism
```

An initial documentation checker could not spawn synchronous Git subprocesses
inside the sandbox (`EPERM`). The file-only Node checks and direct shell Git
checks subsequently passed; no permissions or application code were changed to
work around it. No database test, schema setup or migration was run. Dependency
installation, lint, typecheck, full suites and build were not rerun for this
documentation-only change. The full candidate validation remains a prerequisite
in the release checklist, not a claimed result of this preparation.

No live Daytona/GitHub transport tests, resource creation, credential provisioning,
production changes or release activation occurred. Repository branch/commit/draft
PR maintenance is the only GitHub write authorized for this preparation.
**NO LIVE PROVIDER TESTS PERFORMED.**
