# Phase 1A-3H: Git object transfer safeguards

Stacked on PR #9's `cr8or-014-workspace-lifecycle-safeguards` branch, starting
from `bcbd8861b0be69c32409d658822b53e50d64ae7e`. This implements the missing
object transfer below the existing private Git release restriction. It does not
activate authentication or any private provider operation.

## Architecture and integrity

One approved `push` now spans the registered Daytona repository and its exact
registered GitHub repository. The existing opaque Git grant and PostgreSQL
mutation reservation remain in force throughout export, upload, verification
and non-force branch advancement. The remote-only adapter rejects push; failure
to export local objects cannot fall back to advancing an arbitrary remote commit.

The fixed Python helper reuses the existing descriptor-relative repository
checks, filesystem scan, strict configuration policy, root-owned Git binary,
fixed arguments, fresh environment and repository lock. It receives only bounded
operation metadata over the installed Daytona session-input API. It checks the
canonical origin, exact branch and expected local HEAD before and after export.
No shell fragments, repository paths, executable names or credentials are
accepted from a client or model.

The supported graph is a nonempty linear chain of unsigned SHA-1 commits ending
at the approved remote base. That base must exist locally as a verifiable commit
and remotely as the exact current branch tip. Its existing history is not
recreated. Every new commit's complete trees and blobs are included. Missing
parents, trees or blobs, unreachable extras, duplicate records, special modes,
symlinks, submodules and sensitive paths fail closed. Binary and empty blobs
retain their exact bytes.

The exporter hashes every raw object as Git does:
`SHA-1(type + " " + byteLength + NUL + objectBytes)`. The application server
independently repeats that calculation, parses canonical tree/commit bytes,
verifies types, ancestry, path containment and closure, and checks the approved
repository/branch/head/base binding. Raw tree ordering and file modes are
preserved. Base64 is a transport encoding, not confidentiality.

GitHub Git Database API calls create blobs, then trees, then commits in parent
order. The transport checks the creation SHA and fetches the resulting object
for independent byte reconstruction/hash verification. It does not assume that
recreating a commit produces the same SHA. Any changed message, identity,
timestamp, tree, parent or returned SHA fails verification. The branch is never
advanced to a substituted commit. Only after object verification does the
existing `advance-branch` adapter check ancestry, recheck the expected remote
head, issue `force: false`, and verify the final branch reference.

The initial supported commit representation is deliberately narrow: canonical
UTF-8 tree/parent/author/committer headers, one parent, whole-second UTC dates and
the trusted project's neutral numbered title followed by a newline. New commit
identifiers must increase through the transferred chain. Merges, signatures,
extra headers, non-UTC historical dates, SHA-256 repositories and unsupported
formats are rejected rather than rewritten. Future commits created by the fixed
helper use a server-owned UTC timezone; historical objects remain unchanged.

## Authorization, approvals and credentials

Push approval retains owner, initiating session, credential generation, canonical
project, registration, exact Daytona ID, repository, source branch, local target
SHA and expected remote SHA. A server-generated transfer-policy version is now
part of the scope digest. Old push approvals without that version cannot be
reinterpreted as approval for object upload; their audit rows are retained and a
fresh approval is required. No migration or new approval table is needed.

Balanced/strict policies still require a one-time scoped approval. Autonomous
policy waives human approval only. Agent permission tiers, genuine execution
capabilities, revalidation and the hardcoded gate remain mandatory.

The private HTTP composition uses a dedicated future
`CR8OR_PRIVATE_GITHUB_TOKEN` resolver for object transfer, with no fallback to
legacy `GITHUB_TOKEN`/`GH_TOKEN`. Before a separately approved release, the
operator must verify a short-lived GitHub App installation credential or
fine-grained credential restricted to the exact repository and necessary
Contents write/Metadata read permissions. Merely naming a variable does not
attest its permissions. No credential was configured or used here.

Credentials remain on the application server and are sent only as GitHub HTTPS
authorization headers to fixed repository endpoints. They never enter Daytona
stdin, command arguments, environment, remotes, approvals, audit events or tool
results. Object contents are internal transport data, never application logs or
agent receipts. Daytona and GitHub remain trusted infrastructure and can observe
submitted contents; session-output transport does not prevent provider retention.

## Limits, concurrency and uncertain outcomes

The implementation bounds each transfer to 16 new commits, 128 objects, 256 KiB
per object, 1 MiB total raw objects, a 2 MiB encoded transcript, 512 expanded tree
entries, depth 32 and 4 KiB relative paths. Oversized graphs fail without partial
success or silent truncation. Existing filesystem scan bounds remain in force.

The fixed helper has a 30-second deadline. The existing session transport has a
40-second ceiling, five-second SDK calls and bounded cleanup attempts. The
existing outer Git coordinator retains its 45-second deadline for the complete
operation, including both transports; stage ceilings are not additive allowances.
Export Git subprocesses also have a 256 MiB virtual-address-space limit; packed
repositories requiring larger mappings fail closed. Ordinary Git operations
retain their existing limits. The GitHub phase permits at most 300 requests in
30 seconds, including final branch advancement, with 1 MiB request/response
bodies. Fetch waits and uploader-owned body reads have five-second deadlines;
the existing branch adapter's body reads share the aggregate deadline. No
unbounded queue or automatic retry is introduced.

PostgreSQL still prevents duplicate dispatch and conflicting workspace/repository
mutations across instances. Authorization is checked before export, during waits,
before subsequent GitHub operations and before releasing a receipt. Revocation,
expiry, rotation or request abort suppresses further work and output. Session
cleanup is attempted without claiming that deletion reverses external work.

Once an object POST has been dispatched, any unverifiable outcome, later branch
change or failed branch advancement remains `UNKNOWN`. Uploaded but unreferenced
objects are not automatically deleted or retried. The durable reservation and
audit record remain for separately authorized operator reconciliation. Successful
receipts identify the verified branch and exact approved commit, not raw objects.

## Changed files

Implementation:

- `src/lib/security/git-object-transfer.ts` (new): independent graph validator and canonical object serializers.
- `src/lib/security/git-operation-catalogue.ts`: versioned transfer scope in push approvals.
- `src/lib/security/private-git-http.ts`: authorized transfer factory composition.
- `src/lib/workspace/private-github-object-transfer.ts` (new): bounded exact-object GitHub upload and verification.
- `src/lib/workspace/private-git-operations.ts`: export/upload adapter and removal of remote-only push fallback.
- `src/lib/workspace/private-git-program.ts`: fixed-purpose object export and UTC commit environment.
- `src/lib/workspace/private-git-session.ts`: bounded export-session protocol.

Tests and boundary checks:

- `scripts/check-auth-client-boundary.mjs`
- `tests/helpers/daytona-session-adapter.ts`
- `tests/helpers/git-object-github-adapter.ts` (new)
- `tests/integration/git-authorization.test.ts`
- `tests/unit/git-object-transfer.test.ts` (new)
- `tests/unit/git-operation-catalogue.test.ts`
- `tests/unit/git-operations.test.ts`
- `tests/unit/private-git-object-session.test.ts` (new)
- `tests/unit/private-git-transfer-integration.test.ts` (new)
- `tests/unit/private-github-object-transfer.test.ts` (new)

Documentation: this report (new) and the follow-up link in
`docs/reviews/phase-1a-3f-git-operations.md`. No dependency, Prisma schema,
migration, project identity or release-gate file changes.

## Validation

Executed with Node.js 24.19.0 and npm 11.9.0 against the reviewed `bcbd886`
foundation. All listed scripts exist. No dependency changes were made.

| Check | Actual result |
| --- | --- |
| `npm ci` | Passed; 929 packages installed |
| `npx prisma validate` | Passed using only a disposable test connection |
| `npx prisma generate` | Passed; Prisma 6.19.3 |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run test:unit -- --no-file-parallelism` | 2,606 passed across 58 files |
| `npm run test:auth-db` | 529 passed across 10 files |
| `npm run test:execution-auth` | 428 passed across 7 files |
| `npm run test:lifecycle` | 375 passed across 4 files |
| `npm run test:git` | 904 passed across 15 files |
| `npm run test:auth-http` | Passed all 7 compiled HTTP check groups |
| `npm run test:auth-boundary` | Passed all 15 client-import rejection probes |
| `npm run build` | Passed |

The full unit suite includes 82 object-integrity tests, 42 export-session tests,
27 uploader tests and 18 actual-helper cross-component transfer tests. These
exercise two consecutive development cycles using commits produced by the real
fixed Python helper, exact binary/UTF-8/empty contents, complete ancestry,
tampering, resource limits, revocation, interruption, remote changes and
uncertain outcomes. PostgreSQL coverage includes 131 Git approval/coordination
tests, with cross-instance one-time consumption and durable uncertainty. Suite
counts overlap and must not be added as distinct tests.

Final code-validation results use the reviewed foundation, including its existing
workspace isolation correction. No GitHub Actions result is used as local
validation evidence.

Tests use disposable real Git repositories, isolated PostgreSQL, synthetic
credentials and controlled SDK/GitHub adapters. They do not prove live Daytona
session behavior or GitHub commit normalization.

## Release limitations

Private Git execution remains hardcoded release-blocked, as do cloud writes,
development commands, workspace lifecycle and repository cloning. There is no
environment-variable bypass. No live owner workspace or production repository
was used, and no production database, environment, credential or registration
was modified. No production migration, merge or manual deployment was performed.

Before release, separately authorized isolated provider verification must prove
the installed session behavior, bounded transport, actual GitHub byte/SHA
preservation, dedicated credential permissions and sandbox isolation. Provider
metadata cannot attest peer processes, filesystem contents or historical
credentials. A same-UID process can race local namespace checks; immutable object
hash verification detects content substitution but is not an execution sandbox.

Full trees are checked, so an unsupported or sensitive tracked file can block a
transfer even when that file is unchanged by the new commit. Limits can also
reject large repositories. No object is silently omitted to make an upload fit.

GitHub's REST branch-update API has no expected-old-SHA compare-and-swap field.
The existing exact-head rechecks, ancestry check, non-force update and final
verification are retained, but an external writer can race between them.
Cancellation cannot undo a completed remote mutation. These residual provider
semantics remain release-review prerequisites; no success is reported without
the required verification.

## Interface references

- Installed `@daytona/sdk` `Process.d.ts`: `createSession`,
  `executeSessionCommand`, `sendSessionCommandInput`, command status/logs and
  `deleteSession`; no invented stdin or pack-upload API is used.
- [GitHub Git commits](https://docs.github.com/en/rest/git/commits?apiVersion=2022-11-28):
  explicit author/committer, ISO-8601 dates, parents, tree and message; signatures
  add a header and are outside the supported representation.
- [GitHub Git trees](https://docs.github.com/en/rest/git/trees?apiVersion=2022-11-28):
  explicit entry modes/types/SHAs, no base-tree inheritance, nonrecursive reads
  with truncation rejected.
- Next.js 15.5.22 route-handler reference was read from the matching upstream
  source because the installed package has no `node_modules/next/dist/docs`.
  Existing Node runtime, origin/authentication checks and no-store behavior remain.
