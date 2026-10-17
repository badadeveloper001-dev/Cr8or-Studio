# Phase 1A-3F: Pull request safeguards

The later [Git naming consistency correction](phase-1a-3f-naming-consistency.md)
supersedes this report's successor-numbering rule with shared commit/PR change
identifiers. The implementation and validation below describe CR8OR-012.

This focused correction follows commit
`e08084059a3725f2eac62e0b1749edfa5a30fc20` on the existing draft PR #8.
All private Git, cloud-write and command-execution release restrictions remain
in place. No live GitHub operation or production resource is used for validation.

## Trusted title generation

The private create-PR adapter no longer passes a change category as a PR title.
Neither the public operation catalogue nor the internal transport accepts an
arbitrary title or a caller-supplied sequence number.

`git-project-naming.ts` contains a reviewed server-owned repository-to-code
registry. Its initial entry maps the already-authorized canonical repository
`badadeveloper001-dev/cr8or-studio` to `CR8OR`. Other repositories fail closed for
PR creation until a reviewed mapping is added. Project names, model output,
remote commit prefixes and request fields cannot select the project code.

The intended title is deterministic from immutable approved data:

1. Read the complete bounded ancestry of the exact approved head SHA. Require
   the first returned SHA to match; reject incomplete, paginated or oversized
   history.
2. Find the largest existing identifier in that history for the trusted project
   code and add one. With no such identifiers in verified complete history, use
   one. Format with at least three digits and the approved permitted category,
   such as `CR8OR-012: General maintenance`.
3. Scan complete bounded current branch/tag histories and all open/closed PR
   titles in that same repository. Reject the candidate if an equal or greater
   identifier already exists. Recheck refs, PR-numbering snapshots and the exact
   head/base SHAs immediately before dispatch.

The existing repository/workspace mutation reservation serializes this
application's mutations across instances. No new counter or database table is
introduced. A stale candidate is rejected rather than silently changed after
approval. A second PR from the same approved head cannot claim the same number;
the owner must review a new head containing appropriate updated project history.
Existing commits, titles and identifiers are not rewritten.

The existing five neutral categories remain unchanged. Source history and
unrelated PR bodies are not returned or logged. All existing response, duration,
history and ref-count bounds remain enforced; the all-state PR listing must also
fit below 100 entries without a pagination link. Larger repositories remain
blocked pending a separately reviewed bounded-pagination design.

## Approval integrity

Create-PR scopes add `pullRequestNaming` with version `1`, the trusted project
code and strategy `approved-head-successor`. The existing scope digest binds
these fields together with the canonical repository, exact approved head/base,
branches and category. These immutable inputs determine the title; changing
current repository state can only deny execution, not substitute a new title.
The generated approval preview includes the naming rule and inputs.

The adapter independently reconstructs and compares the request scope before
accessing the server credential. Existing owner/session validation, ten-minute
approval expiration, credential-generation binding, one-time consumption and
runtime revalidation are preserved. Autonomous policy still cannot bypass
authentication, repository binding or release restrictions.

Historical create-PR approvals lacking the naming binding are rejected, not
upgraded. Their database audit records remain intact. Unsupported scopes are
omitted from review listings so valid unrelated approvals remain usable;
database failures continue to fail closed. No migration is required.

## Draft and outcome verification

The transport submits exactly one `POST /pulls` with `draft: true`. Both its
response and the subsequent fetched PR must confirm the exact repository,
head/base branch names, expected head/base SHAs, generated title, open state and
`draft: true`. The fetched PR number must equal the created number. Postflight
checks require the new PR to be the sole addition to the numbering snapshot,
the sole user of its identifier and consistent with unchanged refs.

Any failure after mutation dispatch is `UNKNOWN`, never reported as success.
The existing coordinator retains the unresolved mutation reservation. There is
no automatic recreation, title update, closure, merge or retry. Cancellation or
authorization loss stops subsequent scheduling and output release, but cannot
undo an already-created PR.

## Remaining limitations

GitHub does not atomically reserve custom title identifiers or offer a
compare-and-swap transaction spanning these checks and PR creation. Another
actor can race dispatch, change titles, or change PR state after verification.
Observed conflicts are uncertain outcomes; this code does not claim global
uniqueness against arbitrary external actors. All private Git operations remain
hardcoded release-blocked pending separate provider/conflict verification.

Tests exercise the real create-PR adapter and transport with controlled fetch
responses, and real approval persistence in disposable PostgreSQL. They do not
establish live GitHub behavior or permission configuration. No production
credentials, databases, environment variables or Daytona workspaces are used.

## Validation

Validation used Node.js **24.19.0**, npm **11.9.0**, disposable PostgreSQL **16**
and synthetic credentials. Final checks all passed:

| Command | Actual result |
| --- | --- |
| `npm ci --cache /tmp/cr8or-012-npm-cache` | Passed; 929 packages installed |
| `npx prisma validate` | Passed with disposable database URLs |
| `npx prisma generate` | Passed; Prisma Client 6.19.3 |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run test:unit -- --no-file-parallelism` | 2,086 passed across 50 files |
| `npm run test:auth-db` | 390 passed across 9 files |
| `npm run test:execution-auth` | 289 passed across 6 files |
| `npm run test:auth-http` | Six compiled-server check groups passed |
| `npm run test:auth-boundary` | Nine server-only client-import probes passed |
| `npm run build` | Passed with network access available for build dependencies |
| `git diff --check` | Passed |

Suite totals overlap. The final suites include 133 GitHub transport tests, 45
real adapter-to-transport cases with controlled fetch, 119 catalogue tests and
93 PostgreSQL Git authorization cases. This correction adds 126 unit cases and
13 database cases. Tests confirm UNKNOWN coordination outcomes without any
follow-up mutation and preserve the existing release restrictions.

Initial Prisma validation lacked `DIRECT_URL`; rerunning with the disposable
loopback URLs passed. An intentional invalid-input test fixture needed a
TypeScript cast correction before the final type check. A network-restricted
build failed during webpack compilation without detailed diagnostics; rerunning
with network access passed without changing build settings. The project uses
Google Fonts at build time. No failing result is represented as a passing run.

No dependency upgrades, migration changes or live provider tests were performed.
The known GitHub Actions account restriction was not investigated.

## Changed files

13 files changed:

- `docs/reviews/phase-1a-3f-git-operations.md`
- `docs/reviews/phase-1a-3f-pr-correction.md`
- `scripts/check-auth-client-boundary.mjs`
- `src/lib/security/git-approvals.ts`
- `src/lib/security/git-operation-catalogue.ts`
- `src/lib/security/git-project-naming.ts`
- `src/lib/workspace/private-git-operations.ts`
- `src/lib/workspace/private-github-api.ts`
- `tests/integration/git-authorization.test.ts`
- `tests/unit/git-operation-catalogue.test.ts`
- `tests/unit/git-operations.test.ts`
- `tests/unit/private-git-pr-integration.test.ts`
- `tests/unit/private-github-api.test.ts`
