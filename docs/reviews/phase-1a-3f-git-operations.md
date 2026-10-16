# Phase 1A-3F: Git operation safeguards

Implementation starts from PR #7 commit
`4d6ab65982c61a9fe05c3aa8695664e5bbb8b586` and is stacked on
`cr8or-009-command-execution-safeguards`.

**All private-mode Git operations remain release-blocked.** The implementation
provides mechanisms exercised with disposable repositories, isolated PostgreSQL
and controlled provider adapters. Those checks do not establish live Daytona or
GitHub compatibility. No production authentication, credentials, environment,
database or workspace is changed by this implementation.

## Authorization architecture

The existing PostgreSQL owner session remains the authority. The execution path
is owner session → canonical registered project → verified repository/workspace
→ operation catalogue → agent permission and policy → scoped approval when
required → opaque grant → shared coordination → provider operation → current
authorization and result verification.

The server requires agreement between `Project.repository` and
`Workspace.repositoryUrl`, plus the existing exact Workspace registration,
Daytona provider workspace ID and registered branch. Accepted repository
identities are credential-free GitHub HTTPS or GitHub SSH-form URLs, normalized
to the same owner/repository key. Other hosts, embedded credentials, query
strings, fragments and arbitrary repository selections are rejected. The
transport constructs its own fixed GitHub API URLs.

Historical records with absent or conflicting repository bindings fail closed.
No project ID, GitHub reference, workspace registration or Daytona ID is rewritten
to make a request work. Resolving an operation neither clones a repository nor
creates, starts or replaces a sandbox.

An execution capability must originate from genuine owner authentication.
Opaque Git grants retain the exact capability, operation scope, actor, policy
profile and approval receipt. Matching JSON fields do not fabricate a grant.
Every validation resolves the session and current registry again; expired,
revoked and obsolete credential generations cannot continue. Agent identities
select the existing fixed tool tier; `actorRole` and client claims do not grant
owner authority. Runtime read grants cannot authorize mutations.

## Operation catalogue

| Category | Operations | Transport and scope |
| --- | --- | --- |
| Repository reads | `status`, `branch`, `changes`, `diff`, `log`, `remote` | Fixed Git helper in the registered Daytona sandbox and repository |
| GitHub reads | `list-branches`, `list-contents`, `read-file`, `pr-checks` | Fixed GitHub API origin, registered repository and applicable branch/path |
| Local Git mutations | `stage`, `unstage`, `commit` | Expected branch, HEAD and index digest; exact paths or staged commit state |
| Remote mutations | `push`, `create-branch`, `create-pr`, `upsert-file` | Expected remote head and exact repository, branch and operation targets |

Read authorization does not grant mutation permission. All mutations require a
matching one-time approval under balanced and strict policies. Autonomous mode
explicitly waives human approval, while retaining authentication, repository
binding, capability validation, coordination and release restrictions. A policy
profile change invalidates an existing grant. Policy administration retains its
existing process-local behavior.

The existing agent `git_status` and `git_diff` tools pass through this boundary.
Private diffs require explicit relative paths; an omitted path is not silently
expanded to the whole repository. No additional unrestricted Git/terminal tool
is introduced. Unsupported operations remain denied.

## Structured approvals

Git approvals extend the existing `/api/security/approvals` workflow and use the
same session-binding, immutable decision and one-time receipt model as command
approvals. They do not reinterpret legacy `git.commit-push`, `github.write` or
other action-only approvals as private Git authorization.

The structured scope contains:

- Fixed owner, canonical project, Workspace registration and exact Daytona ID.
- Canonical repository, operation and registered branch.
- Relevant paths, target branch/commit, base branch and expected base SHA.
- Expected local HEAD/index, remote head and existing file blob where applicable.
- Neutral change category, content digest where applicable, and a canonical
  digest of the complete operation payload.

Titles and previews are generated from the stored scope. Submitted owner,
session, workspace, repository, role, preview or approval claims are not trusted.
Raw file content is not persisted in approval scope. A digest binds the exact
content; changing content, category, branch, file or expected state requires a
new approval. A digest-only preview is not a source diff; frontend presentation
of a full proposed patch remains outside this task.

Approvals bind to both the initiating authenticated session and credential
generation. Creation, decision, consumption and receipt validation require that
session to remain valid. Another owner device must request its own approval.
Locking, expiration, credential rotation, revoke-all, project remapping or an
explicit approval revocation invalidate subsequent use. Lifetime is ten minutes
according to PostgreSQL time, capped by session expiry. Consumed receipts remain
subject to expiry and revocation.

Persistence locks the owner/session and current project/workspace registration
before deciding or consuming an approval. Approval row locking, conditional
updates and the unique consumed-operation receipt allow one consumption across
application instances. A missing, generic, denied, expired, mismatched or already
consumed approval cannot mint a privileged grant. Database failures deny access.
A consumed approval is not refunded if subsequent execution cannot proceed.

## Private API contracts

Private POST requests require the existing session cookie, configured same-origin
`Origin`, `Content-Type: application/json` and `X-CR8OR-Auth: 1`. Responses remain
`Cache-Control: no-store`. Authentication and origin checks run before bounded
body parsing. Caller-supplied legacy `owner`/`repo` selections are not accepted in
private request envelopes.

A local status request to `POST /api/github/ops` is:

```json
{
  "projectId": "registered-project-selector",
  "operation": { "operation": "status" }
}
```

An explicit-path diff uses:

```json
{
  "projectId": "registered-project-selector",
  "operation": {
    "operation": "diff",
    "paths": ["src/example.ts"],
    "staged": false
  }
}
```

A structured approval request to `POST /api/security/approvals` uses the same
operation payload that would later be executed. The hashes below are illustrative
synthetic values; actual expected state must come from the authorized repository.

```json
{
  "intent": "request",
  "payload": {
    "action": "git.operation",
    "projectId": "registered-project-selector",
    "operation": {
      "operation": "stage",
      "branch": "main",
      "expectedHead": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "expectedIndex": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "paths": ["src/example.ts"]
    }
  }
}
```

Creation returns `201` with the generated approval DTO. Decisions remain
`{"intent":"decide","payload":{"id":"approval-uuid","decision":"approved"}}`,
with `denied` and `revoked` also supported. `GET /api/security/approvals` returns
the current session's durable approvals alongside unrelated legacy workflows;
it does not expose internal session references or credential generations.

A remote request to `POST /api/github/api` uses the registered project selector
and structured operation, never an arbitrary repository URL:

```json
{
  "projectId": "registered-project-selector",
  "approvalId": "11111111-1111-4111-8111-111111111111",
  "operation": {
    "operation": "push",
    "branch": "main",
    "expectedRemoteHead": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "targetCommit": "cccccccccccccccccccccccccccccccccccccccc"
  }
}
```

Both operation routes currently validate identity and canonical scope, then
return the hardcoded `503` release restriction. They consume no approval and
reserve no mutation while blocked, and never fall through to legacy Git or
broad-token API implementations. These contracts are prepared for later reviewed
integration; they do not announce enabled production Git functionality. Existing
frontend request/approval submission has not been adapted in this task.

## Fixed-purpose Daytona Git execution

The helper uses fixed argv with no shell invocation for Git. The SDK shell command
contains only a fixed Python program. A bounded JSON metadata frame arrives over
session input, followed by a server-authorized `START` frame. Source contents,
owner-session references and credentials do not appear in command arguments.
Input echo is suppressed through the existing SDK session option.

The helper opens only the fixed repository root and its `.git` directory using
non-following descriptor operations, preserves their identities across checks,
and takes a nonblocking repository lock. It scans for symbolic links, hard-linked
regular files and special files, rejecting unsupported worktrees, submodules,
attributes, alternate object databases, replace refs, shallow metadata and
unapproved configuration. Sensitive paths and traversal are rejected. HEAD,
branch and index state are rechecked before mutations.

A strict configuration allowlist permits basic non-bare repository settings,
credential-free `origin` and ordinary branch tracking. Git runs with a fresh
explicit environment, temporary HOME, no inherited application/provider
environment, no terminal credential prompts, no credential helper, no network
protocols, no system/global configuration, no hooks, external diff/text conversion,
signing, automatic maintenance or replacement objects. The Git executable and
its ancestors must be trusted and not writable by the sandbox user. Unsupported
configurations are rejected rather than rewritten.

These controls are not an OS sandbox. A hostile same-UID process can race
filesystem checks or interfere with Git. Restricting the working directory does
not prevent access to other sandbox files. Provider admission independently
requires the exact existing started Daytona ID, the expected non-root user,
private visibility, blocked network, no alternate network routes, no volumes,
empty reported environment and conservative CPU/memory/disk metadata. It does
not attest that a historical filesystem has no credentials or that every process
shares the asserted isolation. Those are release prerequisites.

Local commit titles use `PROJECT-001: General maintenance` and the following
fixed categories: `General maintenance`, `Code improvements`,
`Documentation updates`, `Test improvements`, `Configuration updates`.
The helper scans all locally available refs for the maximum sequence and rejects
incomplete/oversized history instead of silently reusing an identifier. Commit
messages go through stdin. Commits do not invoke push, merge or deployment.

## GitHub transport and credentials

The server adapter accepts only a trusted resolved repository, a structured
operation, a server-provided credential and a revalidation callback. Requests
use the fixed `https://api.github.com` origin with redirects disabled. Tokens are
sent only in the HTTPS authorization header, not in URLs, shell commands, scopes,
receipts, model prompts or logs. Only validated minimal DTOs leave the adapter;
provider URLs and error bodies are not returned. Repository and branch inputs
cannot select another host or repository.

`push` means advancing a verified branch to an already-existing commit in that
same remote repository. The adapter verifies the target object, ancestry and
expected head, sends `force:false`, then verifies the returned and observed head.
It does not upload locally created objects or give a sandbox GitHub credentials.
A complete local-commit-to-remote push transport remains unimplemented and blocked.
GitHub branch protection is respected through the normal API; no override or
merge operation is provided.

Branch creation uses the exact reviewed source SHA. Pull requests are created as
drafts with verified same-repository head/base branches and expected SHAs; no
automatic merge occurs. File updates use the expected existing blob SHA (or
explicit absent-file expectation), the registered branch, exact UTF-8 content
and a neutral title. Verification checks the resulting Git blob hash and remote
commit/ref state. No mutation is automatically retried.

Remote file-update numbering enumerates complete branch and tag listings, then
scans the complete reachable history of each distinct tip. It permits at most
32 combined refs and 1,000 distinct commits; each listing/history must fit below
100 entries with no pagination link. A full page, incomplete history, oversized
message or exhausted sequence fails closed. It rechecks the entire branch/tag
snapshot and expected branch head before returning the next identifier. Higher
identifiers on other branches or tags therefore affect the next sequence. Shared
repository coordination prevents this application's concurrent mutations from
selecting the same sequence. External ref changes after verification remain a
race and keep the release restriction necessary. Local `--all` describes all
available local refs, not proof that every remote branch was fetched; remote
numbering describes GitHub's enumerated branches/tags, not deleted or unreachable
historical commits.

GitHub ref and Contents APIs do not provide an atomic expected-old-branch-head
compare-and-swap covering the whole operation. Preflight and postflight checks
and `force:false` prevent many substitutions and history rewrites, but cannot
eliminate changes between checks and dispatch. A response that cannot be verified
is `UNKNOWN`, never an asserted success. A client disconnect or abort does not
prove GitHub rejected a dispatched mutation.

Historical inactive-stage Daytona clone paths supply the server's `GITHUB_TOKEN`
(or equivalent fallback) as the provider's Git password. Provider handling may
persist credentials in remotes, configuration, helper storage, logs or sandbox
files. This implementation does not inspect production workspaces, rotate those
tokens or destructively clean up existing credentials. The new private path never
uses that cloning path or forwards those credentials to Daytona. A separate
operator-approved least-privilege credential and historical-sandbox review is
required before release. The provider/control plane remains trusted infrastructure
and can observe submitted source contents.

## Coordination, limits and cancellation

PostgreSQL advisory locks and partial unique indexes allow one unresolved Git
mutation per repository and per Daytona workspace across Vercel instances.
Command and Git reservations also share the workspace coordination lock and
check each other's unresolved operations, preventing a development command from
running concurrently with a reserved Git mutation. Duplicate operation IDs cannot
be dispatched twice. There is no execution queue; conflicting work fails closed.
Git mutations are limited to six starts per five-minute window across the matching
repository/workspace records.

| Resource | Bound |
| --- | --- |
| Private HTTP request body | 2 MiB, 10-second read deadline |
| File content for GitHub update/read | 256 KiB; exact UTF-8, no silent truncation |
| Relative path | 4 KiB; up to 64 operation paths, 16 KiB aggregate |
| Helper metadata frame | 32 KiB |
| Helper execution | 30 seconds, bounded CPU/file-descriptor/file-size limits |
| Helper scan | 50,000 entries |
| Helper output | 256 KiB, sanitized fixed result framing |
| Daytona transport | 40 seconds, individual SDK calls capped at 5 seconds |
| Cleanup budget | 5 seconds |
| GitHub adapter | 30 seconds per invocation, 1 MiB response body, at most 100 list entries; numbering additionally caps 32 refs and 1,000 unique commits |
| Outer operation | 45 seconds plus bounded cleanup/coordination completion |
| Authorization during execution | Before each sensitive dispatch and output release, with a 2-second in-flight recheck |

Cancellation combines the initiating request's abort signal, deadline and session
revalidation. Invalid authorization stops scheduling further work and prevents
private output release. The transport attempts a `CANCEL` frame and waits for
terminal result/process evidence; the helper attempts process-group termination.
Deleting a Daytona session is cleanup, not proof that Git or all descendants
stopped. Failed confirmation or cleanup leaves the result uncertain.

A dispatched mutation with uncertain completion is retained as `UNKNOWN` and
continues to occupy its coordination slot. Lost `RESERVED`/`RUNNING` operations
are also not reclaimed merely because they are old. There are no automatic retry,
lease-expiry unlock or browser reconciliation endpoints. Trusted operator review
of provider/repository state is required before any future reconciliation.
Completed-record cleanup excludes unresolved records and records inside the rate
window.

Authorization cannot be atomically committed with an external Git/GitHub effect.
If revocation is detected before a subsequent action, that action is denied;
already-completed work cannot be undone by a session check. The implementation
does not claim stronger cancellation or atomicity.

Audit events record generated operation ID, project, catalogue operation, actor,
status and timestamps without source text, raw output, tokens or environments.
Durable operation records preserve the execution/scope identity and outcome.
Provider errors are sanitized; ambiguous outcomes are retained for reconciliation.

## Additive migration and deployment procedure

`prisma/migrations/20261016020000_git_operations/migration.sql` adds:

- `GitApproval`: immutable scope snapshot/digest, session and credential-generation
  binding, decision/revocation timestamps, bounded lifetime and one-time consumed
  operation/actor receipt. It reuses `CommandApprovalStatus`.
- `GitOperation`: operation/execution identity, repository/workspace scope,
  lifecycle timestamps, completion status, exit code and cancellation/cleanup
  evidence. It reuses `CommandOperationStatus`.

The migration adds lifecycle constraints, unique approval-consumption receipts,
partial unique unresolved repository/workspace indexes, lookup/cleanup indexes,
RLS and removal of PUBLIC privileges. Identity snapshots preserve audit history
without treating stale records as authority. Existing projects, authentication,
workspaces and command records are not dropped, recreated or renumbered.
`prisma/manual-schema.sql` includes matching fresh-bootstrap definitions and is
not the incremental deployment procedure.

After independent review and before deploying code requiring these new tables,
a trusted operator must run the existing explicit migration command against the
intended approved database:

```sh
npm run db:migrate
```

Ordinary Prisma imports and requests do not deploy migrations. This assignment
runs migrations only against isolated test infrastructure. No production command
or connection information is provided here.

## Release prerequisites and compatibility limits

The hardcoded `assertPrivateGitAvailable` restriction applies to private route,
agent and runtime entry points. There is no request, policy, legacy-token or
environment override. Existing cloud-write and development-command restrictions
remain in force. Autonomous policy does not bypass any release gate.

Before any release, independently verify exact SDK session behavior, Python/Git
runtime support, helper echo/framing and cleanup, provider isolation, historical
credential removal/rotation through an approved procedure, least-privilege GitHub
credentials and remote conflict semantics. Mocked provider tests do not complete
these prerequisites. No live test against an owner sandbox or repository was
performed as part of this implementation.

Strict helper configuration, links/attributes/submodules, large histories,
missing project repository records, unsupported refs and whole-repository diffs
can keep otherwise legitimate historical projects blocked. These restrictions
are deliberate and must be addressed narrowly before activation; existing IDs
and records are preserved. Private local-host Git remains denied. Inactive-stage
legacy application behavior is retained, with deployment protection still
required while private authentication remains inactive. Frontend locking,
preview/deployment execution, Face ID and later phases are outside this change.

## Validation

Actual local validation used Node.js **24.19.0**, npm **11.9.0** and disposable
PostgreSQL **16**. All commands below completed successfully:

| Check | Actual result |
| --- | --- |
| `npm ci --cache /tmp/cr8or-011-npm-cache` | Passed; 929 packages installed, no dependency changes |
| `npx prisma validate` | Passed |
| `npx prisma generate` | Passed; Prisma Client 6.19.3 |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run test:unit -- --no-file-parallelism` | 1,960 tests passed across 49 files |
| `npm run test:auth-db` | 377 tests passed across 9 files |
| `npm run test:execution-auth` | 276 tests passed across 6 files |
| `npm run test:auth-http` | Six compiled-server check groups passed, including Git scopes, durable approvals and release restrictions |
| `npm run test:auth-boundary` | Nine real Next.js client-import probes rejected server-only security modules as expected |
| `npm run build` | Production build passed |
| `git diff --check` | Passed |

Suite totals overlap. New Git coverage includes 80 PostgreSQL authorization and
coordination cases, 60 actual disposable Git/Python helper cases, 37 transport
cases (including three actual helper executions through a controlled SDK-shaped
adapter), 70 controlled GitHub API cases, plus catalogue, grant/coordinator,
store, route and approval tests. These new tests ran within the suites above;
the aggregate `test:git` script is also provided for focused future runs.

An earlier run with concurrent full suites and helper tests exceeded existing
fixture deadlines. The final serial unit and database runs passed; no existing
authentication or cloud-write timeout was weakened to obtain those results.
In-progress test mock/type issues were corrected before final validation.

Database checks used loopback-only disposable PostgreSQL, random test schemas
and synthetic owner credentials. Local helper checks exercised real temporary
repositories. Controlled provider adapters do **not** prove live Daytona/GitHub
compatibility. No live provider mutation or production infrastructure was used.
The known GitHub Actions account restriction was not investigated; these are
actual local execution results. Existing dependency vulnerabilities remain
separately tracked; no package upgrade or lockfile change was made.

## Changed files

41 files changed in this implementation:

- `docs/reviews/phase-1a-3f-git-operations.md`
- `package.json`
- `prisma/manual-schema.sql`
- `prisma/migrations/20261016020000_git_operations/migration.sql`
- `prisma/schema.prisma`
- `scripts/check-auth-client-boundary.mjs`
- `scripts/check-private-authorization-http.mjs`
- `src/app/api/github/api/route.ts`
- `src/app/api/github/ops/route.ts`
- `src/app/api/security/approvals/route.ts`
- `src/lib/agents/tool-executor.ts`
- `src/lib/security/command-operation-store.ts`
- `src/lib/security/execution-context.ts`
- `src/lib/security/git-approvals.ts`
- `src/lib/security/git-authorization.ts`
- `src/lib/security/git-operation-catalogue.ts`
- `src/lib/security/git-operation-store.ts`
- `src/lib/security/private-git-http.ts`
- `src/lib/workspace/private-git-availability.ts`
- `src/lib/workspace/private-git-operations.ts`
- `src/lib/workspace/private-git-program.ts`
- `src/lib/workspace/private-git-session.ts`
- `src/lib/workspace/private-github-api.ts`
- `src/lib/workspace/providers/daytona.ts`
- `src/lib/workspace/runtime-cloud.ts`
- `src/lib/workspace/runtime-local.ts`
- `tests/integration/command-approvals.test.ts`
- `tests/integration/command-execution-authorization.test.ts`
- `tests/integration/command-operation-store.test.ts`
- `tests/integration/git-authorization.test.ts`
- `tests/unit/git-operation-catalogue.test.ts`
- `tests/unit/git-operation-store.test.ts`
- `tests/unit/git-operations.test.ts`
- `tests/unit/private-command-approval-route.test.ts`
- `tests/unit/private-direct-workspace-boundary.test.ts`
- `tests/unit/private-git-program.test.ts`
- `tests/unit/private-git-route.test.ts`
- `tests/unit/private-git-session-local.test.ts`
- `tests/unit/private-git-session.test.ts`
- `tests/unit/private-github-api.test.ts`
- `tests/unit/workspace-authorization-runtime.test.ts`
