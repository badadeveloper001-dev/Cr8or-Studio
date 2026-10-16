# Private API authorization — Phases 1A-3A and 1A-3B

This stage connects the existing private owner-session system to the backend API
boundary. It reuses the Phase 1A-1 PostgreSQL session store and Phase 1A-2
authentication services. It does not activate production authentication, add a
frontend lock screen. Phase 1A-3B adds the
[trusted execution boundary](trusted-workspace-authorization.md). The final production cutover remains Phase 1A-5.

## One activation configuration

`CR8OR_PRIVATE_AUTH_ENABLED`, `CR8OR_PRIVATE_AUTH_ORIGIN`, and
`CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY` remain the single private-authentication
configuration. There is no additional API-enforcement switch. The origin and key
requirements are documented in the
[access-code services guide](private-access-code-authentication.md).

| Configuration | Backend behavior |
| --- | --- |
| All three private-authentication variables absent | Private authentication is inactive; existing application behavior is retained. |
| Only `CR8OR_PRIVATE_AUTH_ENABLED=false`, with origin and key absent | Same inactive behavior. The value must be exactly `false`. |
| `CR8OR_PRIVATE_AUTH_ENABLED=true` and a valid origin and key | Private authentication services and the protected API boundary are enabled together. |
| Any other combination | Fail closed with a generic `503`; no legacy or synthetic-owner fallback. |

The presence of an origin or key, even an empty value, makes a partial setup an
error. A malformed enabled value, a missing enabled value alongside other private
configuration, or `false` alongside an origin/key cannot silently disable the
boundary. Configuration is evaluated on the server for each request.

The old `CR8OR_FEATURE_AUTH_GUARD` setting is not a private-authentication switch.
Its value cannot disable the private-session requirement once private
configuration selects the new boundary. In the explicitly inactive stage, the
legacy behavior remains solely to preserve the current workspace until the
reviewed cutover; this is not an alternate authentication method for an active
private workspace. Private authentication endpoints continue returning `503`
while their configuration is inactive.

No production settings are changed by this implementation. Until the controlled
activation, deployment-level access protection must cover every production,
preview, branch, custom-domain, and other reachable deployment URL. Verify the
provider's actual settings and coverage; this code change does not establish that
those protections are enabled. Do not activate private authentication before the
remaining backend, frontend-locking, and deployment checks are reviewed.

## Trusted owner context

Protected requests use only the configured private session cookie. The opaque
token is resolved through PostgreSQL, which validates its digest, expiration,
revocation, owner relationship, and credential version. Missing, malformed,
forged, expired, revoked, and obsolete sessions cannot produce an authenticated
owner context. The existing fixed 12-hour maximum lifetime is unchanged.

The resulting server-only context identifies the fixed singleton `owner` and
assigns the owner role on the server. Client-supplied identities, roles, session
IDs, bearer-token presence, legacy developer tokens, and Supabase tokens do not
establish private access. Disabling the old authentication flag cannot create a
synthetic owner in private mode.

Existing route role and workspace-ownership helpers remain in use. They consume
the verified singleton context rather than treating a client claim as ownership.
The singleton owner can access historical projects through the existing owner
authorization semantics. No project ID, workspace ID, project/workspace relation,
GitHub reference, or Daytona workspace identifier is rewritten. There is no new
account type, registration endpoint, invitation flow, or ownership migration.

There is no cross-request authorization cache. PostgreSQL remains the authority
for session validity; existing process-local policy settings, approvals, audit
events, and metrics are not session authorities. A database failure cannot grant
access or cause fallback to the legacy authentication path.

## Middleware and handler boundaries

Next.js 15.5 Node.js middleware validates private sessions for protected API
requests. Cookie presence alone is never sufficient. Protected handlers repeat
database validation through their server-side boundary, so direct handler
invocation or bypassing middleware does not bypass authentication. Middleware
does not send a client-reusable identity assertion that handlers trust.

Middleware and handlers each query PostgreSQL; retained operation-specific
helpers may validate again. Before activation, check database pool capacity,
Node.js middleware support, and latency on the intended Vercel deployment.

The handler boundary runs before request-body parsing, integration-secret reads,
project queries, filesystem access, provider calls, cloud creation, or deployment
work. Existing operation-specific authorization and policy checks remain inside
that boundary. Authentication failures retain the API's
`{ok:false,message,error:{code,message}}` convention:

- `401` for missing or invalid private sessions.
- `503` for unavailable authentication infrastructure or invalid configuration.
- `503` for operations whose execution isolation/lifecycle remains unavailable.
- `404` for unknown registered projects; `409` for changed or ambiguous runtime bindings.

Sensitive handler responses include `Cache-Control: no-store`, including rejected
requests. Errors do not expose database diagnostics or authentication metadata.

Private mutations also require the exact configured `Origin` and
`X-CR8OR-Auth: 1`. If supplied, `Sec-Fetch-Site` must be `same-origin`. These checks
apply to protected POST operations as well as unlock and lock. Protected GET,
HEAD, and OPTIONS requests do not require a mutation origin header, but still
require a valid private session. No wildcard credentialed CORS policy is added.

Only three exact route-and-method pairs are public at the middleware boundary:

| Public route | Method | Behavior |
| --- | --- | --- |
| `/api/auth/unlock` | POST | Origin/input/rate checks, server-side access-code verification, session creation and secure cookie issuance. |
| `/api/auth/session` | GET | Minimal authenticated/unauthenticated status from the private session resolver; infrastructure errors remain `503`. |
| `/api/auth/lock` | POST | Origin protection and idempotent session revocation/cookie clearing; failed revocation never reports success. |

There is no `/api/auth/*` prefix exemption and no general OPTIONS exemption.
Other methods on those exact authentication paths return `405` with the matching
`Allow` header directly from middleware; their handlers also reject unsupported
methods independently. Unlock remains available without a preexisting
session when the complete private configuration is valid.

## Protected route authorization matrix

The following 17 protected routes contain 23 existing operation methods. Every
listed method requires a PostgreSQL-validated singleton-owner session in private
mode. Existing role labels remain useful operation policies; they do not create
additional users. Each protected route also has an authenticated OPTIONS handler
that returns method metadata without invoking its operation. Next.js HEAD
handling on routes with GET passes through the protected GET boundary.

| Route | Method(s) and operation | Category / authorization after the central boundary |
| --- | --- | --- |
| `/api/projects` | GET: list projects; POST: create project | Protected read/write; existing viewer/maintainer checks precede database operations. |
| `/api/projects/workspace` | POST: recent/open/create/clone | Cloud listing/open/reuse is guarded; local directory management and new cloud provisioning remain unavailable in private mode. |
| `/api/workspaces` | GET: list cloud projects; POST: create/clone cloud project | Protected listing and existing repository reuse; new provisioning returns `503` in private mode. |
| `/api/workspaces/[projectId]/preview` | POST: start/refresh/stop preview | Returns `503` in private mode pending process/URL lifecycle authorization. |
| `/api/files` | GET: list/read; POST: write | Verified registered project/runtime binding, per-operation session revalidation, path containment, and existing write policy. Private cloud writes are unavailable; private POST bodies are bounded. |
| `/api/github/api` | POST: list/read repositories, branches, files and checks; upsert file/create branch/create PR | Protected external read/write; authentication precedes secret access, and existing write-role/ownership/policy checks remain. |
| `/api/github/ops` | POST: status/diff/stage/unstage/commit-push | Returns `503` in private mode until local commands have an isolation boundary. |
| `/api/deploy` | POST: build/deploy | Returns `503` in private mode until local command/deployment lifecycle authorization is complete. |
| `/api/chat/main` | POST: AI chat and workspace/tool actions | Verified owner session and registered project; shared guarded runtime for direct reads and tools. |
| `/api/orchestrate` | POST: agent orchestration | Trusted context propagates through agents, model calls, memory work, tools, and runtime operations. |
| `/api/orchestrate/stream` | POST: streaming agent orchestration | Same trusted execution boundary; awaited progress validation and disconnect cancellation. |
| `/api/health/slis` | GET: service metrics and feature configuration | Protected operational diagnostics; no public health-data exemption. |
| `/api/security/audit` | GET: audit records | Protected operational diagnostics; existing owner check and audit feature gate remain. |
| `/api/security/readiness` | GET: integration-secret readiness | Protected operational diagnostics; no unauthenticated configuration disclosure. |
| `/api/security/approvals` | GET: list; POST: request/decide | Protected read/write; existing action, role and ownership checks remain. |
| `/api/security/policy` | GET: policy rules; POST: update profile | Protected read/write; existing owner and ownership checks remain for changes. |
| `/api/security/sandbox` | GET: runtime state; POST: cancel operation | Protected operational diagnostics/control; existing owner and ownership checks remain. |

The earlier implementation had no handler authorization on `/api/health/slis`,
read GitHub credentials before authorization, parsed several bodies before their
authorization checks, and depended on a default-disabled legacy guard that could
return a synthetic owner. The central boundary closes these paths in private
mode without treating middleware as the sole authorization layer.

## Execution restrictions and remaining limits

The [Phase 1A-3B guide](trusted-workspace-authorization.md) describes the trusted
execution context, revalidation, runtime containment, historical workspace reuse,
and operation-specific restrictions. The three AI entrypoints now use that
boundary. Unsupported local command paths, previews, and new cloud provisioning
remain unavailable in private mode; inactive staging behavior is preserved.

Session checks cannot recall a completed external operation or atomically
combine a database decision with a filesystem/provider effect. Revocation stops
subsequent work at the next validation boundary, with best-effort cancellation
of supported pending operations. The frontend lock screen, final deployment
protection verification, and production cutover remain pending.

## Validation procedure

Use Node.js 20 and a supported Node.js 22+ runtime for dependency installation, Prisma validation/generation, ESLint,
TypeScript, unit tests, authentication database tests, and a production build.
Exercise real protected route handlers for invalid cookies, revoked/expired or
obsolete sessions, legacy-token attempts, infrastructure failures, invalid
configuration, mutation-origin checks, and rejection before sensitive side
effects. Verify public authentication behavior, trusted agent execution, and remaining operation restrictions.

Database-backed verification uses only an explicitly configured disposable local
PostgreSQL database through `CR8OR_AUTH_TEST_DATABASE_URL`; never substitute
production credentials. Keep test schemas and synthetic owner credentials
isolated. See the [access-code guide](private-access-code-authentication.md) for
the existing database-test safeguards and client-bundle boundary checks.

After `npm run build`, run `npm run test:auth-http` with the same isolated test
database variable. This check creates a disposable schema, provisions a public
synthetic credential, and starts the compiled Next.js server on localhost. It
exercises Node.js middleware, protected handlers, the secure-cookie lifecycle,
infrastructure failures, and active/partial/inactive configuration. It removes
the schema and terminates its own server processes afterward. It refuses local
dotenv files so Next.js cannot silently supply configuration for the inactive
case. The check manually transports secure cookies over localhost HTTP; it does
not replace HTTPS browser and Vercel deployment verification before activation.

The database suites run sequentially because the verification-capacity lock is
database-wide even when fixtures use different schemas. Do not run the HTTP
check concurrently with other private-authentication database tests.

Actual command results belong in the change's review record. The known GitHub
Actions account restriction is not a local test result and is not bypassed here.
Previously identified dependency vulnerabilities remain tracked separately; this
stage does not introduce unrelated dependency upgrades.

The Node.js 20 installation currently reports existing engine requirements of
Node.js 22 or newer in AI SDK, Supabase, and nanoid dependencies. Passing local
checks does not establish vendor-supported Node.js 20 operation for those
packages. Runtime/dependency alignment remains a separate review item; no
dependency versions or lockfile entries are changed by this stage.
