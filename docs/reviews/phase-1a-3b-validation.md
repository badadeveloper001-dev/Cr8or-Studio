# Phase 1A-3B implementation and validation record

Base: PR #4, `cr8or-005-authorization-improvements`, reviewed HEAD
`1489719686c1a708a545ea3d8885bc2ab379d2a5`.
Implementation branch: `cr8or-006-workspace-authorization`.

## Result

Agent, chat, and orchestration execution now carry a server-created immutable
capability binding the initiating PostgreSQL owner session to a registered
project and its runtime. The capability is checked before model requests, tool
execution, runtime operations, memory updates, and streamed results. Internal
session references use private class fields; raw tokens never enter the agent
context. Revocation, expiry, rotation, registry changes, database failures, and
cancellation stop subsequent sensitive work.

The three AI POST endpoints are available through this boundary in configured
private mode. Local/cloud general commands and Git operations, preview control,
new cloud provisioning, legacy local directory management, and legacy Git/deploy
routes remain unavailable in private mode where adequate isolation or lifecycle
coverage is missing. Inactive-stage behavior is retained.

See the [architecture and limitations](../trusted-workspace-authorization.md)
and [complete API route matrix](../private-api-authorization.md).

## Actual local validation

Checks ran on 2026-10-16 using Node.js **20.20.2 / npm 10.8.2** and
**24.19.0 / npm 11.9.0**, with the existing lockfile unchanged.

| Check | Node 20 | Node 24 |
| --- | --- | --- |
| `npm ci` | Passed; existing engine warnings | Passed |
| `npx prisma validate` | Passed | Passed |
| `npx prisma generate` | Passed, Prisma 6.19.3 | Passed, Prisma 6.19.3 |
| `npm run lint` | Passed | Passed |
| `npm run typecheck` | Passed | Passed |
| `npm run test:unit` | 1,147 passed / 32 files | 1,147 passed / 32 files |
| `npm run test:auth-db` | 142 passed before the final additional execution case | 143 passed / 4 files, including the final 42 execution cases |
| `npm run test:execution-auth` | Final 42 cases passed | Same final 42 cases passed within `test:auth-db` |
| `npm run build` | Passed, Next.js 15.5.22 | Passed, Next.js 15.5.22 |
| `npm run test:auth-http` | Four compiled-server check groups passed | Four compiled-server check groups passed |
| `npm run test:auth-boundary` | All three actual client-import rejection probes passed | All three actual client-import rejection probes passed |
| `git diff --check` | Passed | Passed |

An initial unit run concurrent with build/database work hit existing 5-second
scrypt-test timeouts and cascading mock-count failures. The final sequential run
passed all 1,147 tests without changing scrypt parameters or relaxing those tests.
The final additional PostgreSQL execution case was verified in the separate
42-case Node 20 run and the full 143-case Node 24 run.

The unit totals include 37 focused runtime/helper cases, including actual Python
filesystem execution and special-file rejection. The three client probes compile
real credential, owner-management, and execution-context modules from Client
Components and require Next.js's specific `server-only` rejection diagnostic;
other build failures do not count as success.

## Test coverage

Behavioral tests cover real route handlers, private-session provenance, missing
and fabricated contexts, client-supplied IDs and tool overrides, PostgreSQL
revocation/expiry/rotation, project deletion/remapping/aliasing, cloud provider
association mismatches, direct-chat filesystem access, tool permission tiers,
approval policy, origin checks, cancellation, and revoked/expired streaming
execution. The real orchestrator and streaming route use mocked model output only
to invalidate the actual database session at a deterministic execution boundary;
no external model call is made. The fixed Python filesystem helper is executed
against temporary directories to test actual no-follow read/write/list behavior.

Database checks use only a disposable PostgreSQL 16 container bound to loopback,
explicit isolated-test configuration, synthetic credentials, and per-suite
schemas. Compiled HTTP checks start local Next.js servers against disposable
schemas. Production credentials and databases are never used.

## Remaining review items

- No live Daytona workspace was accessed. Its trusted Python 3/POSIX helper
  support must be verified in an authorized isolated sandbox before activation;
  lack of support fails closed without an SDK fallback.
- Already-dispatched provider/file operations cannot be atomically revoked with
  a PostgreSQL session change. Revalidation prevents subsequent work and result
  release after detection; cancellable provider requests receive abort signals.
  The fixed cloud filesystem helper has a 30-second execution timeout.
- General runtime commands, preview processes/URLs, and new cloud provisioning
  remain blocked in private mode pending sufficient isolation/lifecycle work.
- Revalidation adds database round trips at sensitive boundaries. Confirm pool
  capacity and latency on the intended deployment before activation.
- The host filesystem and Daytona runtime/control plane are trusted. Application
  path checks do not replace operating-system isolation.
- Node.js 20 is a compatibility comparison only: existing AI SDK, Supabase, and
  nanoid dependencies declare Node.js 22+ engine requirements. No dependency
  versions or lockfile entries are changed. Existing audit findings stay separate.
- Deployment protection remains necessary while private authentication is
  inactive. Frontend locking, activation review, and production cutover remain
  outside this task. The known Actions account restriction was not investigated.

No production authentication activation, real owner provisioning, production
migration, environment change, merge, or manual deployment was performed.
Project IDs, Workspace IDs, Daytona IDs, GitHub references, histories, and stored
relationships are preserved; this change adds no migration or ownership table.

## Changed files

- `README.md`
- `docs/private-access-code-authentication.md`
- `docs/private-api-authorization.md`
- `docs/reviews/phase-1a-3b-validation.md`
- `docs/trusted-workspace-authorization.md`
- `package.json`
- `scripts/check-auth-client-boundary.mjs`
- `scripts/check-private-authorization-http.mjs`
- `src/app/api/chat/main/route.ts`
- `src/app/api/deploy/route.ts`
- `src/app/api/files/route.ts`
- `src/app/api/github/ops/route.ts`
- `src/app/api/orchestrate/route.ts`
- `src/app/api/orchestrate/stream/route.ts`
- `src/app/api/projects/workspace/route.ts`
- `src/app/api/workspaces/[projectId]/preview/route.ts`
- `src/lib/agents/executor.ts`
- `src/lib/agents/llm.ts`
- `src/lib/agents/orchestrator.ts`
- `src/lib/agents/tool-executor.ts`
- `src/lib/agents/tool-loop.ts`
- `src/lib/agents/tools.ts`
- `src/lib/intent/llm-classifier.ts`
- `src/lib/security/auth.ts`
- `src/lib/security/execution-context.ts`
- `src/lib/security/session-store.ts`
- `src/lib/workspace/authorized-runtime.ts`
- `src/lib/workspace/cloud-projects.ts`
- `src/lib/workspace/cloud-service.ts`
- `src/lib/workspace/private-cloud-files.ts`
- `src/lib/workspace/private-runtime-path.ts`
- `src/lib/workspace/runtime-cloud.ts`
- `src/lib/workspace/runtime-factory.ts`
- `src/lib/workspace/runtime-local.ts`
- `src/lib/workspace/workspace-inspection.ts`
- `src/middleware.ts`
- `tests/integration/execution-authorization.test.ts`
- `tests/integration/private-authorization.test.ts`
- `tests/unit/agent-execution-authorization.test.ts`
- `tests/unit/agent-model-authorization.test.ts`
- `tests/unit/cloud-project-authorization.test.ts`
- `tests/unit/execution-routes.test.ts`
- `tests/unit/private-authorization.test.ts`
- `tests/unit/private-cloud-files.test.ts`
- `tests/unit/private-direct-workspace-boundary.test.ts`
- `tests/unit/private-middleware.test.ts`
- `tests/unit/workspace-authorization-runtime.test.ts`
