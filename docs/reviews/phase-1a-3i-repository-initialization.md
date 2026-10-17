# Phase 1A-3I: Repository initialization safeguards

Stacked on PR #10, reviewed head
`a0bc3d2b0812b4d55adeff4074171f4e1645000f`. This implements a server-mediated,
bounded repository initialization mechanism below the existing hardcoded clone
and lifecycle release restrictions. No production capability is activated.

## Supported functionality and trust boundary

The supported operation initializes a **new, reserved project and sandbox** from
the complete supported history of one authorized GitHub branch. It does not use
an archive, shallow clone, rewritten commit or SDK credential-bearing clone.
Existing projects, registrations, sandboxes and repository histories are retained.

The supported subset is intentionally small: SHA-1 Git repositories with at most
16 unsigned, zero/one-parent commits, canonical UTF-8 commit metadata and UTC
timestamps. Original messages and object identities are retained, without applying
new-commit naming rules to historical messages. Merges, signatures, extra commit
headers, non-reconstructable metadata, unsupported modes and missing objects fail
closed. All history must reach a genuine root; it is never truncated to fit.

The inherited sensitive-path policy rejects every `.git`-prefixed tracked entry,
including `.gitignore`, `.github` and `.gitattributes`, plus credential-sensitive
paths. Initialization additionally rejects `.config`, matching the helper. These
checks apply to every retained tree, including files absent from the final HEAD.
This is not general-purpose cloning, and this implementation does not claim that
the Cr8or Studio repository itself satisfies the supported subset. Expanding it
requires a separately reviewed change, not an insecure fallback.

## Authorization, approval and lifecycle integration

The owner is authenticated against PostgreSQL before resolving GitHub metadata.
The server derives the reserved project/registration identities from the existing
session/idempotency mechanism and resolves the exact branch HEAD through the
canonical GitHub repository. Clients cannot supply project IDs, sandbox IDs,
expected HEADs or initialization policy claims for clone requests.

Clone approval now includes an immutable
`initialization: { version: 1, strategy: "complete-sha1-git-database", expectedHead }`
scope. Existing ten-minute lifetime, one-time consumption, owner/session/credential
generation binding and balanced/strict policy requirements remain. Autonomous
policy only waives human approval. Legacy clone approvals missing this scope are
invalid; they are not upgraded. Approval previews show the exact intended HEAD.

Execution resolves the current HEAD again; a stale approval is rejected rather
than updated. Complete source download and integrity validation run before any
sandbox creation. The existing durable reservation then coordinates creation and
initialization across instances. Once the provider returns an exact, isolated,
correctly labelled resource, its ID is recorded before object transfer begins.

The service independently verifies repository contents after initialization and
rechecks provider identity/isolation before registration. Both the service and
store require exact repository/branch/HEAD and complete-history evidence before
inserting a ready Project/Workspace. PostgreSQL stores no source contents or GitHub
credentials. No schema change or migration is required; the existing JSON approval
scope and lifecycle operation records hold the additional binding.

## Object integrity and credentials

The application server uses read-only GitHub Git Database API requests for
commits, nonrecursive trees and blobs. It verifies canonical repository identity,
initial/final branch HEAD and every object hash using Git's exact header and bytes:
`SHA-1(type + " " + length + NUL + content)`. Reconstructed structured commit/tree
responses must reproduce the original SHA; API normalization never substitutes a
new identity. The graph validator independently checks closure, ancestry, object
types, path policy, modes and resource limits. Binary and empty blobs are exact.

Only the application server holds the dedicated future
`CR8OR_PRIVATE_GITHUB_CLONE_TOKEN`; no legacy `GITHUB_TOKEN`/`GH_TOKEN` fallback is
used. A separately authorized release must independently verify an appropriate
short-lived installation or fine-grained credential restricted to the intended
repository and necessary Contents read/Metadata read permissions. An environment
variable name does not prove least privilege. No credential was configured here.

Tokens travel only in authorization headers to fixed `https://api.github.com`
repository endpoints. They never enter Daytona, Git remotes/configuration,
commands, prompts, source graphs or receipts. Errors contain fixed messages rather
than provider details. Both providers remain trusted infrastructure; session-input
echo suppression does not prevent provider observation or retention of contents.

## Daytona filesystem mechanism

The existing SDK session interfaces are used: `createSession`,
`executeSessionCommand`, `sendSessionCommandInput`, command status/logs and
`deleteSession`. The fixed Python program is the only command argument. Metadata
and bounded object bytes travel over framed session input with echo suppressed.
No arbitrary commands, destination paths, environments or Git arguments are
accepted. The destination is the existing fixed `repo` directory beneath the
verified sandbox's SDK working directory.

The helper independently verifies hashes and complete history, creates a private
sibling staging directory, writes loose objects and a minimal credential-free
Git configuration, and materializes regular files using descriptor-relative,
no-follow operations. Symlinks, hard links, special files, unsafe paths and
unexpected existing content are rejected. The origin URL contains no credentials.
Untrusted file reads are nonblocking before checking inode type, so FIFO metadata
cannot trap inspection before its special-file rejection.
Git runs only with fixed arguments, a fresh environment, disabled hooks/helpers/
protocol access and a trusted executable. Exact objects/configuration, branch,
HEAD, full `rev-list`, `fsck --strict`, worktree and clean index are verified.

After STAGED, the application revalidates the initiating PostgreSQL authorization
before sending COMMIT. The helper verifies the staging tree again and publishes
using Linux `renameat2(RENAME_NOREPLACE)`. If this primitive is unavailable, it
fails closed. An existing destination is never replaced, even if it appears
between preflight and publication. A marker inside `.git` binds the installation
to the operation/project/registration/sandbox/repository/branch/HEAD; reconciliation
cannot adopt an unrelated repository merely because its commit matches.

The service performs a separate read-only verification against a fresh exact-ID
session after initialization. Operation receipts contain only safe state/identity
evidence, never source objects. Existing SDK generic clone/upload/shell mechanisms
are not fallbacks.

## Limits, cancellation and reconciliation

| Resource | Bound |
| --- | --- |
| Complete history / objects | 16 commits / 128 objects |
| Individual object / total raw graph | 256 KiB / 1 MiB |
| Expanded HEAD worktree | 1 MiB, including repeated references to one blob |
| Framed graph / relative path | 2 MiB / 4 KiB |
| Expanded tree entries / tree depth | 512 / 32 |
| Directory verification/cleanup scan | 2,048 entries |
| GitHub source transport | 300 GET requests / 30 seconds; no retries |
| Each GitHub request and streamed response | 5 seconds / 1 MiB |
| Each Daytona session | 40 seconds / 1,000 SDK calls |
| Session input chunks / returned output | 12 KiB / 4 KiB |
| SDK request / cleanup | 5 seconds each; bounded cleanup polling |
| Python helper | 35 seconds wall time, 15 CPU seconds, 256 MiB address space |
| Fixed Git subprocess | 10 CPU seconds, 256 MiB address space, 64 KiB output |
| Individual generated filesystem file | 2 MiB |
| Entire lifecycle operation | Existing 60-second deadline; stage ceilings are not additive |
| Shared provisioning coordination | Existing one concurrent provisioning operation, four pending operations, three creations per 15 minutes |

Staging stores at most the bounded object graph plus bounded checkout, index and
small fixed metadata. There is no pack expansion, arbitrary temporary upload or
unbounded buffering. Child processes, session cleanup, directory enumeration and
abandoned-stage inspection are bounded. Only this invocation's verified temporary
directory is eligible for its best-effort cleanup; existing destinations and
historical staging directories are never destructively recovered.

Authorization is revalidated before requests, during bounded waits, before COMMIT
and before registration/output. Revocation, expiration, credential rotation or
abort prevents subsequent authorized steps. There is an unavoidable race between
the last database check and an external atomic publication; cancellation cannot
undo a publication that already happened. Session deletion is not proof that a
remote process was terminated. Provider loss/SIGKILL can leave staging data.

Failure after sandbox creation leaves the same reservation and sandbox ID
unresolved. Reconciliation only inspects: absent, incomplete, mismatched or fully
verified. Absent/incomplete/unexpected HEAD leaves the operation unresolved;
only independently verified completion can register the original resource.
Reconciliation never repeats initialization, creates a replacement, starts a
resource or deletes anything. Changed sandbox identity and invalid owner sessions
fail closed. It currently also requires the source branch to remain at the
approved HEAD and the initiating session to remain valid; otherwise separate
operator handling is required. No automatic destructive recovery is provided.

## Validation

Executed with Node.js 24.19.0 and npm 11.9.0. Every requested script exists.

| Check | Actual result |
| --- | --- |
| `npm ci` | Passed with writable workspace npm cache; 929 packages |
| `npx prisma validate` | Passed with disposable test connection only |
| `npx prisma generate` | Passed; Prisma 6.19.3 |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run test:unit -- --no-file-parallelism` | 2,805 passed across 62 files |
| `npm run test:auth-db` | 554 passed across 10 files |
| `npm run test:execution-auth` | 453 passed across 7 files |
| `npm run test:lifecycle` | 403 passed across 4 files |
| `npm run test:git` | 1,051 passed across 17 files |
| `npm run test:auth-http` | All 7 compiled HTTP check groups passed |
| `npm run test:auth-boundary` | All 19 client-import rejection probes passed |
| `npm run build` | Passed |

Focused new suites verify 87 graph-integrity cases, 60 GitHub-source cases,
29 actual filesystem/session cases, and 20 cross-component cases using the real
Python helper and independently inspecting the resulting Git repository. These
counts overlap the complete suites and must not be added as distinct tests.

The first install attempt failed because the environment's default npm cache was
unwritable; a workspace-local cache resolved it without dependency changes. The
first database run exposed an invalid expiry test fixture and an existing
five-second command-output test timeout during concurrent validation. The fixture
was corrected to respect database timestamp constraints; final database results
are recorded from a serial rerun without changing existing command timeouts.
No GitHub Actions result is used as local execution evidence.

Tests use disposable real Git repositories, synthetic credentials, isolated
PostgreSQL and controlled Daytona/GitHub adapters. They do not establish live
provider compatibility. Tests and application initialization transports did not
use live Daytona or GitHub resources.

## Changed files

Implementation:

- `src/lib/security/git-object-transfer.ts`: exposes the existing canonical tree parser without weakening push validation.
- `src/lib/security/git-repository-initialization.ts` (new): complete rooted graph validator.
- `src/lib/security/workspace-lifecycle-catalogue.ts`: exact initialization scope.
- `src/lib/security/workspace-lifecycle-store.ts`: independent clone completion evidence requirement.
- `src/lib/workspace/private-workspace-lifecycle.ts`: approval, creation, verification and reconciliation integration.
- `src/lib/workspace/private-github-repository-source.ts` (new): bounded server-side object download.
- `src/lib/workspace/private-repository-initialization.ts` (new): trusted source/provider composition.
- `src/lib/workspace/private-repository-program.ts` (new): fixed-purpose remote filesystem/Git helper.
- `src/lib/workspace/private-repository-session.ts` (new): bounded session-input protocol.

Tests and boundary verification:

- `scripts/check-auth-client-boundary.mjs`
- `tests/helpers/repository-github-adapter.ts` (new)
- `tests/integration/workspace-lifecycle.test.ts`
- `tests/unit/workspace-lifecycle.test.ts`
- `tests/unit/git-repository-initialization.test.ts` (new)
- `tests/unit/private-github-repository-source.test.ts` (new)
- `tests/unit/private-repository-initialization.test.ts` (new)
- `tests/unit/private-repository-program.test.ts` (new)

Documentation: this new report and the follow-up link in
`docs/reviews/phase-1a-3g-workspace-lifecycle.md`. No dependency, Prisma schema,
historical migration, project identity or release-restriction files were changed.

## Release prerequisites

Private cloning, lifecycle operations, cloud writes, development commands and
private Git execution remain hardcoded blocked. No environment or request flag
can release them. Production authentication remains inactive; no production
database, environment, credentials, projects or sandboxes were modified.

Separately authorized isolated provider verification must establish SDK input
framing/echo behavior, the expected working directory and snapshot, Python/Git
availability, atomic no-replace rename semantics, GitHub response reconstruction,
credential permissions and sandbox isolation. Filesystem checks cannot attest
the absence of hostile same-UID peer processes, historical credentials or provider
retention. Existing historical credential risks require controlled future
remediation, not cleanup during initialization. No merge or manual deployment
was performed. Independent technical review is required before further work.

## Interface references

- Installed `@daytona/sdk` 0.214.0 `Process.d.ts`, including session input and
  `suppressInputEcho`; no unsupported SDK upload or stdin interface was assumed.
- GitHub Git Database API [commits](https://docs.github.com/en/rest/git/commits?apiVersion=2022-11-28),
  [trees](https://docs.github.com/en/rest/git/trees?apiVersion=2022-11-28) and
  [blobs](https://docs.github.com/en/rest/git/blobs?apiVersion=2022-11-28).
- Next.js 15.5.22's matching route-handler reference; installed package guides
  are absent, so the matching upstream reference was used. Existing Node runtime,
  origin checks, session validation and no-store response behavior remain intact.
