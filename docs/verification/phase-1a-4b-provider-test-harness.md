# Phase 1A-4B: isolated provider test harness

**NO LIVE PROVIDER TESTS PERFORMED.** This change implements a standalone,
offline runner. It does not enable a live backend, authorize provider resources,
activate private authentication or alter application release restrictions.
Every live-provider result remains **NOT RUN**.

The [4A master plan](phase-1a-4a-provider-verification-plan.md),
[matrix](phase-1a-4a-test-matrix.md),
[resource authorization](phase-1a-4a-resource-authorization.md),
[recovery runbook](phase-1a-4a-recovery-runbook.md) and
[release checklist](phase-1a-4a-release-readiness.md) remain authoritative. Their
preparation-time statements that a harness did not yet exist describe that
revision. This document records the narrower implementation now supplied; it
does not mark those documents' live test rows PASS.

## Runner and trust boundary

The Node.js 24 entry point is
[`scripts/provider-verification.mjs`](../../scripts/provider-verification.mjs).
It is outside Next.js routes and imports only the fixed test composition under
[`tests/provider-verification`](../../tests/provider-verification). It accepts no
command, helper program, provider module, working directory, project code or
arbitrary resource selector. There is no `--live` mode or environment-variable
release switch. Unsupported options fail before work begins.

The runner separates three kinds of evidence:

| Boundary | What actually runs offline | What it cannot establish |
| --- | --- | --- |
| Authorization and persistence | Real PostgreSQL owner provisioning with a random synthetic access code, real access-code verification, session persistence, cookie resolution, opaque execution contexts, approvals and mutation reservations | Production database configuration, deployed authentication cutover or provider ownership |
| Filesystem and Git | Actual fixed application Python helpers and Git object operations in newly created temporary directories; exact hashes and independent filesystem observations | Daytona filesystem, terminal, snapshot, isolation, cleanup or performance guarantees |
| Provider transport | Controlled SDK-shaped session/lifecycle adapters and fixed GitHub request/response adapters; no provider SDK client is constructed | Actual Daytona or GitHub API compatibility, credentials, resource existence or billing |

All owner authority originates in the normal PostgreSQL-backed session resolver.
The test creates a session after verifying its synthetic credential, presents its
opaque cookie to the real resolver, and obtains a verified server-owned context.
It does not construct a convincing-looking `AuthSession`, mock session validity,
or accept a client-provided owner/session identifier. Raw session tokens remain
inside that local authentication call and never enter fixtures, adapters or
evidence. Balanced policy and actual operation-scoped, one-time approvals remain
active for high-risk operations.

The test-only composition invokes existing internal mechanisms behind their
unchanged public release facades. Application routes continue to reject private
file writes, commands, Git operations, lifecycle mutations and cloning. This is
not an alternate route to a deployed workspace. Network fetch is denied outside
the controlled GitHub adapter, and real Daytona construction is blocked in the
runner. These controls supplement fixed imports and exact fixture admission;
they are not a claim that arbitrary untrusted code can safely run on the host.

### PostgreSQL admission

[`database.ts`](../../tests/provider-verification/database.ts) admits only
`localhost` or `127.0.0.1`, port `55432`, database `cr8or_auth_test`, with no URL
query, fragment, alternate socket or service-file selection. It refuses deployed
environments and an already-initialized application client. The operator must
provide the disposable instance; the runner cannot create a provider database.
Loopback naming alone does not prove safety: the operator must confirm this
port is not a proxy, SSH tunnel, replica or connection to production.

Each run creates a random `provider_verification_…` schema and applies only the
seven explicitly listed, reviewed historical migrations there. It verifies the
current database and schema before loading synthetic data. It neither discovers
future migrations nor invokes `prisma migrate deploy`. This is test-schema
initialization on isolated infrastructure, never a production migration.

On completion or failure, the runner disconnects but retains that schema,
including approvals, receipts and `UNKNOWN` reservations. No automatic `DROP`,
reservation clearing, deletion of synthetic owner records or destructive recovery
is provided. Retained local schemas and temporary fixtures require explicit
operator housekeeping after evidence review; repeated runs consume local storage.

### Exact fixture admission

The committed offline manifest admits only the compiled synthetic repository
`cr8or-verification/pilot-fixture`, branch `pilot`, and these five logical sandbox
identities:

- `offline-pilot-clone`
- `offline-pilot-execution`
- `offline-pilot-cancellation`
- `offline-pilot-uncertain-command`
- `offline-pilot-timeout`

These are local adapter labels, not actual Daytona resources, permission to
create five sandboxes, or an expansion of 4A's proposed two-sandbox live budget.
The manifest cannot name the application repository, an owner workspace, an
arbitrary adapter, credential or destination. A missing, changed or additional
resource field fails validation; a manifest is not itself owner authorization
for a live mutation.

The runner's compiled naming composition maps only that synthetic repository
to `VFY`. It reuses the real naming validation and actual commit helper through
a test loader alias. Models, requests, CLI arguments and environment variables
cannot select a project code or sequence. The deployed naming map remains
unchanged; `VFY` does not become an authorized production repository identity.

## Running the offline composition

Use Node.js 24 and the repository's installed, lockfile-pinned dependencies.
Python 3, the local Git executable and disposable PostgreSQL are prerequisites.
Do not supply provider credentials. Start from a minimal local test environment;
the runner is not intended to discover or sanitize a developer's entire secret
store. The database endpoint must already have been verified as disposable.

```sh
node --conditions=react-server scripts/provider-verification.mjs --describe
node --conditions=react-server scripts/provider-verification.mjs \
  --run-offline \
  --manifest tests/provider-verification/offline-manifest.json \
  --output /tmp/cr8or-provider-pilot-evidence.json
```

`--describe` reports the fixed capabilities and restrictions without opening a
database or invoking a provider. Offline execution requires the exact manifest,
an admitted database connection supplied through `CR8OR_AUTH_TEST_DATABASE_URL`,
and a new evidence filename. The runner refuses inherited `DATABASE_URL`,
`DIRECT_URL`, provider credential variables and deployment flags rather than
reusing them. Never put a database password
in an argument, committed manifest or evidence file. An existing output file is
not overwritten. The evidence records the actual application commit and SDK
version; changing code or the fixture requires a new run and evidence record.

Only bounded, known local programs are launched. The session adapter recognizes
the exact fixed helper command strings and invokes Python directly without a
shell. The synthetic npm scripts are compiled fixtures, not an input channel for
new code. The fixture generator uses fixed Git argument arrays, a clean
environment, disabled hooks/helpers and time/output limits. Neither adapter
performs provider resource deletion or repository creation over the network.

## Deterministic fixture and critical offline workflow

[`fixtures.ts`](../../tests/provider-verification/fixtures.ts) creates complete
two-commit SHA-1 history using synthetic identities and fixed UTC dates. It
includes binary bytes, an empty file, Unicode filename/content, ordinary text,
and a dependency-free `package.json` containing the five existing command
catalogue entries. Initial history deliberately has no invented `VFY` sequence;
subsequent numbered commits are created by the real application helper. Fixture
identity incorporates its deterministic HEAD, and contents are checked through
Git object IDs, byte lengths and SHA-256 values.

| Workflow | Actual mechanism exercised | Evidence boundary |
| --- | --- | --- |
| Initialize and register | Download/validate controlled GitHub object graph, obtain lifecycle approval, reserve in PostgreSQL, use exact synthetic sandbox, run real initialization helper, inspect independently, register ready | Exact complete history, file digests, branch/HEAD, marker and PostgreSQL association; controlled lifecycle metadata is not isolation proof |
| File creation/modification | Real framed write session and Python helper, ordinary/Unicode/empty content, old/new hash observer, revoke session after STAGED before COMMIT | Exact destination bytes, unchanged sibling, no COMMIT after detected revocation; local atomicity only |
| Development commands | Real opaque grant, scoped approval and PostgreSQL reservation; fixed benign npm scripts; cancellation fixture with parent/child/grandchild | Exit/status, consumed approval, retained operation rows and independently observed local process identities; no claim about escaped Daytona descendants |
| Repeated Git workflow | Real stage/commit helpers create consecutive `VFY` commits, export objects, upload through controlled GitHub transport, non-force update and readback | Exact blob/tree/commit identities and branch target, one-time scope and coordinator behavior; no real GitHub mutation |
| Negative responses and uncertainty | Named adapter faults for invalid identity, interrupted transfer, invalid terminal response, timeout or cleanup failure | Rejection or retained `UNKNOWN`, one dispatch, no blind retry, no false success and no reservation release |

The detailed scenario records identify which variants actually executed. A
workflow touching `INIT-01` does not imply all initialization negatives ran;
`CMD-01` coverage must list which command entries completed and which were used
only in a cancellation fixture. Partial matrix coverage is never silently
promoted to a whole-row live PASS.

This composition completes `npm run typecheck`, `npm run lint`, `npm test` and
`npm run test:unit`. It uses `npm run test:integration` only for the cancellation
fixture; that command is not recorded as a successful normal completion.

The fixed offline evidence catalogue currently contains **25** slots:

| Area | Offline slots (partial variants) |
| --- | --- |
| Authorization | AUTH-02, AUTH-05 |
| Files | FILE-01, FILE-02, FILE-03, FILE-05, FILE-09 |
| Commands | CMD-01, CMD-08, CMD-10, CMD-12 |
| Git | GIT-02, GIT-03, GIT-05, GIT-11, GIT-13 |
| Initialization | INIT-01, INIT-02, INIT-03, INIT-11, INIT-18 |
| Lifecycle | LIFE-01, LIFE-02, LIFE-08 |
| Gates | SEC-03 |

This list is coverage design, not a record of passing tests. Missing scenario
records remain NOT RUN. In particular, AUTH-05's concurrent consumption test
uses real transactions but one application process/pool, so it does not fill
AUTH-06. INIT-18 covers sequential idempotent replay, not cross-instance races.
CMD-08/10 cover same-group descendants only; inconclusive termination must not
be reclassified merely because local fixture disposal later succeeds.
LIFE-08 injects a timeout after controlled creation and checks real PostgreSQL
UNKNOWN retention against the same synthetic resource; it does not time a real
Daytona creation or demonstrate provider cancellation.

The controlled command adapter makes explicit local installation adaptations:
it substitutes the newly created temporary root and current Node/npm paths,
admits the local executable owner, adjusts the UID process limit for the shared
test host, and can shorten the command deadline for a timeout fixture. A root
test process cannot attest to production's unprivileged-user requirement. Local
Git executable ownership is similarly adapted where necessary. These changes
exist only in the offline adapter and are disclosed evidence limitations; they
do not alter application helpers or establish snapshot compatibility.

The cancellation fixture has bounded same-process-group children and a
self-expiry. Independent `/proc` observations compare PID and start time to
avoid PID reuse and distinguish a non-running zombie. Helper terminal status,
session deletion, local fixture cleanup and descendant absence are recorded
separately. A local cleanup routine terminating its own fixture is not evidence
that Daytona's `deleteSession` terminates descendants. Escaped descendants and
hostile same-UID scripts remain future verification blockers.

## Smallest dependency-complete future pilot

This selection is a proposal for later authorization, not an executable live
mode. It avoids draft PR creation, other remote mutation families, exhaustive
capacity/format negatives and broad stress testing. A few shared fixtures can
produce evidence for several IDs, but each observation retains its own ID and
variant. The count is of traceability IDs, not 55 separately created resources.

The approved 4A matrix makes **SDK-01–SDK-09, FS-01–FS-10 and ISO-01–ISO-10**
prerequisites: all **29** remain necessary. Skipping those and calling an ordinary
write/command a safe pilot would omit terminal, no-replace, process, network and
identity assumptions. Their shared probes run first under exact resource and
financial authorization. Any critical FAIL or INCONCLUSIVE blocks dependent
mutations. The current runner has no live probe implementation.

Then run this **26-ID** capability subset, giving **55** IDs including admission:

| Order | Selected existing IDs | Minimum pilot variant and dependencies | Live result |
| --- | --- | --- | --- |
| 1 | SEC-03, SEC-05 | Confirm release gates stay closed and dedicated read/write credentials really target the approved disposable repository; inspect permissions before provider dispatch | NOT RUN |
| 2 | LIFE-01, LIFE-02, LIFE-03, LIFE-05 | Reserve/create one approved fresh sandbox, record exact identity, demonstrate reads do not start it, explicitly stop/start under separate approvals and verify file/registration persistence | NOT RUN |
| 3 | AUTH-05, AUTH-06, AUTH-09 | Mismatched/consumed approval cannot dispatch; two independent processes contend on the same PostgreSQL approval; invalidate the session before the next sensitive boundary | NOT RUN |
| 4 | INIT-01, INIT-03, INIT-16 | Initialize the small complete source, independently verify repo/objects/clean worktree/origin; lose publication acknowledgment and reconcile the original reservation without replay | NOT RUN |
| 5 | FILE-01, FILE-02, FILE-09 | Ordinary and Unicode chunk-boundary writes, exact SHA-256 and old/new replacement checks; revoke after STAGED and preserve old destination | NOT RUN |
| 6 | CMD-01, CMD-08, CMD-09, CMD-10 | Exact benign catalogue scripts, bounded same-group and separately authorized escaped-child cancellation, then invalidation/disconnect with UNKNOWN retention where termination is unconfirmed | NOT RUN |
| 7 | GIT-02, GIT-03, GIT-05, GIT-11 | Actual helper-created neutral commit, complete required graph with binary/empty/Unicode data, exact API readback and non-force ref update; lose mutation acknowledgment and retain uncertainty | NOT RUN |
| 8 | SEC-01, CLEAN-01, CLEAN-04 | Canary scan of permitted surfaces; independent session/process/stage inventory; account for every result and cleanup exception before review | NOT RUN |

The initialization success and lost-acknowledgment variant must use a plan that
fits approved fresh destinations: the same initialization can publish once,
lose its acknowledgment, then be inspected and reconciled. It must not be
replayed merely to generate another result. Existing-file/no-replace variants
under FS tests use separate disposable paths, not another unapproved sandbox.
If a scenario needs a second fresh repository root, sandbox or external observer,
amend the exact inventory before execution; do not reinterpret the budget.

Repository initialization reserves and creates its own fresh sandbox. Either
count that creation as the LIFE-01 observation, or allocate the two separately
approved disposable resources to a lifecycle probe and a fresh clone. Never
initialize over the lifecycle probe's existing registration or repository.

This is sufficient to begin a meaningful isolated compatibility pilot only
after the admission and scope decisions are reviewed. It is not sufficient to
release any capability. Partial variants leave the remainder of their original
row unresolved; `AUTH-06` specifically requires independent processes/clients,
not only concurrent promises within one pool.

### Broader release work still required

| Capability | Additional matrix cases and variants required before broader release review |
| --- | --- |
| Shared authorization | AUTH-01–AUTH-04, AUTH-07–AUTH-08, plus expiry/rotation, mapping, policy and approval variants not executed in AUTH-05/06/09; real two-instance contention and database failure behavior |
| Files | FILE-03–FILE-08 and FILE-10–FILE-13: empty/max size/body/path, special files, malformed frames, publication/cleanup faults, log exposure and read/list bounds; provider variants beyond shared FS probes |
| Commands | CMD-02–CMD-07, CMD-11–CMD-12: injection/env/cwd, actual quota/output/deadline limits, cross-instance rates, malformed responses and cleanup failure; all omitted CMD-01/08/09/10 variants |
| Git | GIT-01, GIT-04, GIT-06–GIT-10, GIT-12–GIT-18: ancestry/bounds/formats/races, hostile config, cancellation/coordination, credential review, draft PR numbering/status and separate remote mutation approvals |
| Initialization | INIT-02, INIT-04–INIT-15, INIT-17–INIT-19: all full matrix variants, including >16 commits, merges/signatures, denied `.git*`/`.config` paths, unsupported modes, graph tampering/bounds, existing destination, interruption/expiry/rotation and uncertain mismatches |
| Lifecycle | LIFE-04, LIFE-06–LIFE-10: unsafe config/drift/destruction policy, limits, failed DB registration, all reconciliation identities/states/attempt budgets and historical-safe-stop variants |
| Credentials and closure | SEC-02, SEC-04, CLEAN-02–CLEAN-03 and every omitted selected-row variant; exact separately approved resource deletion, credential revocation and retained uncertainty disposition |

Some additional cases have useful offline automated coverage already. That
coverage remains separate from actual provider behavior. Unsupported repository
formats are expected restrictions, not defects to bypass to make the pilot
pass. A PASS applies only to the observed variant, version, fixture and scope.

## Evidence and uncertainty

The runner writes a bounded structured artifact rather than raw provider logs.
Each scenario carries its matrix test ID, fixture identity, expected/observed
result, status, application commit, installed SDK version, provider-operation
count, authorization-check labels and cleanup evidence. Safe facts include
counts, content SHA-256, Git OIDs, number of dispatches and persisted operation
state. Authentication tokens/digests, credential hashes, connection strings,
headers, environment values, private source and provider error bodies are not
evidence fields.

The envelope uses `executionKind: "OFFLINE_ADAPTER"`,
`coverage: "OFFLINE_CRITICAL_SUBSET"` and `liveProviderResult: "NOT RUN"`.
It repeats the live status for each row. `providerOperations` counts calls to
controlled adapters; counters may be cumulative within a fixture and must not
be summed as if every row were an independent provider bill. The separate
aggregate `budget.operations` counter counts each controlled call once and
enforces a maximum of 10,000. A 300-second dispatch deadline is checked before
each controlled call; work already dispatched drains under its own bounded
operation/cleanup limits. This is not a hard process-kill deadline or proof of
remote termination. Those local safeguards are not an authorization or price
estimate for a future run.

`PASS`, `FAIL`, `INCONCLUSIVE` and `NOT RUN` are the only verdicts. Offline
records are explicitly tagged offline; controlled calls are not actual provider
operations. Live status remains NOT RUN even when the corresponding local
assertion passes. A fault test can PASS because a database operation correctly
remains UNKNOWN, while its cleanup status remains unresolved. The artifact must
never describe that resource as ready or cleared.

Evidence does not silently overwrite prior evidence. A failure to validate,
serialize or write a safe result is a runner failure, not a successful run with
missing records. Preserve the schema and exact fixture inventory on failure.
No recovery command clears uncertain rows, retries an ambiguous mutation,
substitutes a fresh session or deletes a possibly completed operation.

The envelope also records the manifest digest, working-tree dirty state,
aggregate budget and exact retained local fixture paths/schema name for later
review. These are synthetic local identities, never production registrations.
A scenario is recorded as an interrupted INCONCLUSIVE attempt before its
sensitive work begins; a later assertion replaces that record. Unattempted
catalogue slots remain NOT RUN. CLI exit code `0` requires all records PASS;
`2` reports a completed but INCONCLUSIVE run, and `1` indicates runner/assertion
failure. A completed run does not imply all security observations were confirmed.

## Future live integration: required separate change

There is no provider factory selector in this CLI. A separately reviewed live
factory and exact owner-approved resource manifest must be implemented before
live testing. Replacing a file in the offline manifest or setting a credential
variable is not such an implementation. The future composition would reuse
these existing concrete paths, without opening their public release facades:

| Capability | Existing application path to compose after separate approval |
| --- | --- |
| Isolation and lifecycle | `createPrivateLifecycleProvider` in [private-lifecycle-provider.ts](../../src/lib/workspace/private-lifecycle-provider.ts); `prepareWorkspaceLifecycleWithRepository`, `executeWorkspaceLifecycleWithProvider`, `inspectWorkspaceLifecycleWithProvider`, `reconcileWorkspaceLifecycleWithProvider` in [private-workspace-lifecycle.ts](../../src/lib/workspace/private-workspace-lifecycle.ts) |
| File writes | Exact-ID `DaytonaProvider.getPrivateFileSessionProcess` → [privateCloudWriteSession](../../src/lib/workspace/private-cloud-write-session.ts), using the verified execution context and recheck before COMMIT |
| Commands | [authorizeDevelopmentCommand](../../src/lib/security/command-authorization.ts) with a real scoped approval → exact-ID `DaytonaProvider.getPrivateCommandSessionProcess` → [privateCloudCommandSession](../../src/lib/workspace/private-cloud-command-session.ts) and the existing PostgreSQL coordinator |
| Repository initialization | [createPrivateRepositoryInitializationTransport](../../src/lib/workspace/private-repository-initialization.ts) with dedicated server-side read credential and actual GitHub fetch → bounded [downloadPrivateGithubRepository](../../src/lib/workspace/private-github-repository-source.ts) → exact-ID Git session → fixed initialization/inspection helper → lifecycle registration verification |
| Git/object transfer | Existing real Git approval/grant → [executeAuthorizedGitOperation](../../src/lib/workspace/private-git-operations.ts), `createDaytonaGitAdapter` for fixed local operations and `createGithubObjectTransferAdapter` for export + GitHub object creation/readback + non-force ref update |

The future factory must admit only a separately reviewed exact test account,
snapshot, region, provider ID inventory, repository and branch manifest. New
creation needs a reserved identity and verified returned ID/labels; a supplied
ID is never ownership proof. It must enforce aggregate requests, duration,
resource count, financial ceiling, fixture graph limits and approved cleanup
scope before dispatch. No production/owner IDs, arbitrary URL, local-host
fallback or automatic destructive cleanup are permitted.

Credential permissions must be independently verified: repository-scoped
Metadata/Contents read for retrieval; Metadata read/Contents write for object
upload and branch update. Pull requests write is unnecessary for this minimal
pilot because it does not create PRs. Dedicated Daytona credentials must be
restricted to the approved disposable account/resources; if fine scoping is
unavailable, account isolation is a prerequisite. GitHub credentials and owner
session data stay on the trusted runner and never enter the Daytona sandbox,
argv, Git remotes, npm environments, models or evidence. The dedicated Daytona
credential authenticates control-plane API requests; it must not enter the
sandbox or evidence either. No credentials are configured by this change.

Runtime admission must establish the reviewed snapshot, actual unprivileged
identity, common CWD/repository root, trusted Python/Git/Node/npm, no-replace
support, mounts, network restrictions, secrets absence and process/resource
boundaries. Metadata and mocked results cannot substitute. The current
command-helper offline adaptations must not be copied into live admission.

Before a live run, the owner must separately approve the reviewed factory and
commit, exact test subset/variants, resources, actual credential permissions,
numeric financial limit, time window, observers and cleanup authority. Provider
prices are not assumed. The 4A recovery rules remain binding: UNKNOWN retains
coordination; read-only reconciliation is bounded; no auto-retry, replacement,
deletion or success from an unverifiable response. GitHub REST ref updates still
lack expected-old-SHA compare-and-swap, and session deletion does not prove
descendant termination.

## Validation and release decision

Actual validation used Node.js **24.19.0**, installed Daytona SDK **0.214.0**,
Prisma **6.19.3**, and a newly created loopback-only disposable PostgreSQL 16
container. Only synthetic credentials and test schemas were used.

| Check | Actual result |
| --- | --- |
| `npx prisma validate` / `npx prisma generate` | PASS / PASS |
| `npm run lint` / `npm run typecheck` | PASS / PASS |
| `npm run test:unit -- --no-file-parallelism` | PASS: 2,902 tests in 68 files, including all 97 new harness tests |
| `npm run test:auth-db` | PASS: 554 tests in 10 files |
| `npm run test:execution-auth` | PASS: 453 tests in 7 files |
| `npm run test:lifecycle` | PASS: 403 tests in 4 files |
| `npm run test:git` | PASS: 1,057 tests in 18 files |
| `npm run test:auth-http` | PASS: compiled HTTP security checks against disposable PostgreSQL |
| `npm run test:auth-boundary` | PASS: 19 actual Next.js client-import rejection probes |
| `npm run build` | PASS |
| Standalone `--run-offline` composition | 23 PASS, 2 INCONCLUSIVE; completed with exit code 2 |

Suites overlap; their test counts must not be summed as unique coverage. No
dependencies changed or were upgraded. The full workflow retained its local
fixture inventory and synthetic schema, including UNKNOWN operation records,
for review. No live provider test, owner workspace, production database or
production credential was used. No application source, Prisma schema,
migration, deployment setting or release-gate file changed.

An initial preflight correctly refused an environment containing `GH_TOKEN`
and `NODE_PATH`; neither value was printed or used. The offline invocation can
exclude these inherited variables with `env -u GH_TOKEN -u NODE_PATH` before
`node`, without changing any production environment. Other forbidden variables
must likewise be absent, and no provider credential is needed.

The combined local run recorded **23 PASS and 2 INCONCLUSIVE** across 25 offline
scenarios, with exit code `2`; every live-provider result remains NOT RUN.
The parent, child and grandchild were
independently observed no longer running, but the application could not confirm
the cancellation receipt and retained PostgreSQL status UNKNOWN. Consequently
CMD-08 and CMD-10 were INCONCLUSIVE. Later local fixture cleanup does not upgrade
that result. Confirmed supervisor/provider cancellation remains a blocker, not
a limitation hidden by an otherwise successful workflow.

All application release restrictions remain **BLOCKED**. A successful offline
run only demonstrates the recorded local composition. Even a later successful
isolated live pilot cannot remove a gate, activate authentication, authorize a
merge/deployment or admit historical workspaces. Those require separate review
and explicit owner authorization under the 4A release checklist.
