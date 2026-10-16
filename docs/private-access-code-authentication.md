# Private access-code services — Phase 1A-2

This stage implements operator credential management and private authentication
services on the approved Phase 1A-1 tables and session store. It does **not**
protect all workspace APIs, add a lock screen, activate production authentication,
or implement passkeys. Backend authorization belongs to Phase 1A-3; the reviewed
production cutover is deferred to Phase 1A-5. The subsequent
[authorization guide](private-api-authorization.md) describes the current central
API boundary. [Phase 1A-3B](trusted-workspace-authorization.md) adds trusted agent
execution and documents the remaining operation-specific restrictions.

## Staging and configuration

All three private authentication endpoints return a generic uncached `503` unless
all required configuration is valid. No configuration is read into a permanent
authorization cache, and a missing or malformed value cannot produce a session.

| Server-only variable | Requirement |
| --- | --- |
| `CR8OR_PRIVATE_AUTH_ENABLED` | Exactly `true` enables these services. Every other value, including absence, disables them. Leave this unset in deployed environments during this stage. |
| `CR8OR_PRIVATE_AUTH_ORIGIN` | One exact canonical HTTPS origin, without a trailing slash, path, query, credentials, or fragment. No origin is inferred from request Host/forwarding headers. |
| `CR8OR_PRIVATE_AUTH_RATE_LIMIT_KEY` | A canonical base64url encoding of 32 cryptographically random bytes, supplied through trusted secret configuration. Use the same stable key across instances sharing the owner database. |

In Phase 1A-3A the same configuration also controls protected API enforcement.
Only entirely absent private configuration, or a lone explicit enabled value of
`false`, preserves inactive staging behavior. Any partial configuration, including
an origin/key with a missing or false enabled value, fails closed for protected
APIs. There is no separate endpoint-only activation switch.

Local HTTP is accepted only for `localhost`, `127.0.0.1`, or `[::1]` with
`NODE_ENV=development` or `test` and no Vercel deployment indicators. Production
and Vercel preview deployments require HTTPS and secure cookies. Do not use a
`NEXT_PUBLIC_` variable for any private-authentication configuration or secret.

The existing `CR8OR_FEATURE_AUTH_GUARD` remains a default-disabled legacy
bearer-token/Supabase guard only during inactive staging. Its disabled path creates
a synthetic legacy owner for existing workspace features. Private mode always
takes precedence: central authorization and Node.js middleware validate the
private cookie against PostgreSQL, regardless of the legacy flag. Neither
synthetic identities, Supabase/developer tokens, nor client role claims qualify.
Only the exact public authentication route/methods can reach their handlers
without an existing session. Production activation remains deferred.

Repository inspection found no frontend consumers of `/api/auth/session`.
Its former `authEnabled`/full legacy `session` response is replaced by the minimal
private-session contract below. Existing workspace behavior is otherwise retained.

## Credential representation and performance

`src/lib/security/access-code.ts` uses asynchronous Node `crypto.scrypt`, with
`N=32768`, `r=8`, `p=3`, a random 32-byte salt, and a 64-byte derived key. The
versioned representation is:

```text
$cr8or$scrypt$v=1$N=32768,r=8,p=3$<canonical-base64url-salt>$<canonical-base64url-key>
```

Verification accepts only this bounded, exact format and parameter set. It
rejects unknown versions, excessive/altered costs, invalid lengths, and
noncanonical encodings before derivation. Equal-length derived values are compared
with `crypto.timingSafeEqual`. SHA-256 remains exclusively the random session-token
digest algorithm, not the access-code KDF.

Provisioning, rotation, and authentication accept any nonempty access code up to
1024 UTF-8 bytes, without a mandatory minimum length or composition rules. A single
character, short numerical PINs such as `1234` or `123456`, mixed alphanumeric
codes such as `Studio2026`, and long passphrases are all permitted. This policy is
the same for hidden-terminal and protected-stdin provisioning. Empty, oversized,
and malformed inputs remain invalid; whitespace is preserved and counts as input.

Short PINs have lower guessing resistance, including against offline guessing if
a stored hash is compromised. A unique long passphrase or sufficiently long random
code is recommended, but choosing a shorter code is never blocked. Scrypt and the
existing source/global attempt limits remain unchanged; they do not make short
PINs equivalent in strength to longer unpredictable codes. No extra authentication
step or complexity requirement is imposed. Input is never trimmed or normalized. Invalid
UTF-8 request bytes and unpaired UTF-16 surrogate escapes are rejected, preventing
distinct malformed inputs from collapsing to a replacement character. Verification
also bounds nonempty input before expensive work.

The parameters follow one of the memory/CPU trade-offs in the
[OWASP scrypt guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
The core derivation uses roughly 32 MiB; Node receives a 64 MiB maximum allocation
limit. A smaller memory setting is not silently selected under load.

Run `npm run auth:benchmark` to measure only public synthetic data. Actual local
results on 2026-10-16, Node 24.19.0, Linux x64, Intel Xeon Platinum 8573C with two
available CPUs, while other validation was running:

| Operation, five sequential samples | Median | Maximum |
| --- | ---: | ---: |
| Hash | 307.55 ms | 353.24 ms |
| Verify | 349.95 ms | 417.72 ms |

Peak RSS for the benchmark process was 105.59 MiB, including Node and the script
loader. These are local measurements, not Vercel performance guarantees. Before
activation, measure the selected Vercel function size, connection latency,
concurrent load, and timeout margin in an approved isolated environment. The
verification transaction has a 10-second timeout and a one-second pool wait limit;
infrastructure failures fail closed rather than weakening hashing.

## Trusted operator procedure

The utility requires trusted database/operator access. It loads no `.env` file
itself, runs no migration, and has no public HTTP equivalent. Provision no real
owner during this implementation stage.

After independent review and authorization to provision:

1. Verify the intended database, backups/recovery access, reviewed migrations,
   trusted server role, and browser-role restrictions documented in the
   [foundation guide](private-authentication-foundation.md). Keep the application
   endpoints disabled until the separately reviewed activation step.
2. Install the reviewed dependencies and generate Prisma. Supply `DATABASE_URL`
   and the appropriate `DIRECT_URL` through protected operator configuration;
   never place connection strings in command arguments, Git, or documentation.
3. In a trusted terminal, run one of the following. Provision/rotate prompt twice
   with terminal echo disabled; the access code is not a command argument.

```bash
npm run owner:manage -- status
npm run owner:manage -- provision
npm run owner:manage -- rotate
npm run owner:manage -- revoke-all
```

`provision` inserts only the fixed `owner` identity with a random 32-byte WebAuthn
handle. PostgreSQL uniqueness rejects concurrent/second provisioning. `rotate`
preserves that handle and creation time while updating the encoded hash,
incrementing credential version, and revoking all sessions in one transaction.
`revoke-all` reuses the foundation's generation-changing revocation operation.
`status` returns only provisioning state, version, timestamps, and aggregate
session counts. Revoked/expired counts may overlap; active counts validate version.

For trusted automation, `provision --stdin` or `rotate --stdin` accepts one bounded
UTF-8 JSON object containing only the `accessCode` string, including exact
whitespace. Feed it through protected standard input from a secret manager or a
restricted file. Do not use a literal secret in an `echo` command, shell history,
process arguments, logs, or a committed file. Hidden-terminal mode restores its
state on success, input failure, or supported interruption. CLI results and errors
contain no access code, hash, user handle, connection string, or token.

The CLI runs with Node's `react-server` condition solely to load server-only
TypeScript modules through `jiti`. `jiti@2.7.0` was already locked and used by the
Prisma/ESLint/Tailwind toolchain; declaring that exact version as a direct dev
dependency avoids relying on an accidental transitive loader. No new package
version or transitive dependency was introduced. Do not enable this condition for
browser code. Recovery remains a trusted operator rotation procedure, never a
public recovery or setup endpoint.

## HTTP contracts and cookies

All handlers use the Node.js runtime, dynamic responses, and `Cache-Control:
no-store`, including failures and explicitly rejected methods. No credentialed
CORS policy is added. Unsupported methods return `405` with `Allow`.

Every state-changing request requires exact `Origin` matching configured origin
and `X-CR8OR-Auth: 1`. If `Sec-Fetch-Site` is present it must be `same-origin`.
These checks apply to unlock and lock, including requests without a session.
Credentials belong only in the bounded POST body, never URL parameters.

| Endpoint | Contract |
| --- | --- |
| `POST /api/auth/unlock` | `application/json` (optional UTF-8 charset), no content encoding, actual body <=4096 bytes. Exactly one `accessCode` field. Success: `{ok:true, authenticated:true, expiresAt:"ISO-8601"}` plus session cookie. |
| `GET /api/auth/session` | Validates the opaque cookie against PostgreSQL. Returns `{ok:true, authenticated:true, expiresAt:"ISO-8601"}` or `{ok:true, authenticated:false}`. No legacy identity/roles, database record, token, or hash. |
| `POST /api/auth/lock` | Resolves and revokes the current session, then clears its cookie and returns empty `204`. Already invalid/absent sessions are idempotent. Failed revocation returns `503` without clearing the cookie or claiming success. |

Error responses retain the existing `{ok:false, message, error:{code,message}}`
shape with static public messages: `400 INVALID_REQUEST`, `401 UNAUTHORIZED`,
`429 RATE_LIMITED` with `Retry-After`, `503 SERVICE_UNAVAILABLE`, or
`405 METHOD_NOT_ALLOWED`. Request, credential, Prisma, and crypto error details
are never copied into responses or logs.

An absent owner or malformed stored hash performs dummy scrypt verification and
returns the same generic `401` as an incorrect code. The public dummy hash cannot
authenticate: success always requires an actual owner and its verified version.
Missing tables/unavailable infrastructure return `503`. Disabled configuration
returns the same unavailable response regardless of owner provisioning state.

Production/HTTPS cookies are named `__Host-cr8or-session`, with `HttpOnly`,
`Secure`, `SameSite=Strict`, `Path=/`, no `Domain`, and an absolute `Expires`.
Local HTTP uses the separate `cr8or-dev-session` name without `Secure`; its
configuration cannot be selected for production or Vercel previews. The server
reads only the active configuration's cookie and rejects duplicate cookie names.

The foundation generates the opaque 256-bit token and stores only its SHA-256
digest. Raw tokens occur only in the cookie transport, never JSON or database
records. The requested expiration is calculated from PostgreSQL time after
verification, and the session store independently enforces its 12-hour maximum.
Lookups do not renew it. The exact verified credential version is retained;
session creation's owner-row lock rejects a concurrent rotation/revoke-all.
Multiple devices remain independent until global revocation or rotation.

## Distributed limits and verification capacity

Every well-formed unlock attempt first consumes the PostgreSQL global budget:
30 attempts per five-minute fixed window. A reliable source additionally consumes
five attempts per 15-minute fixed window. Successful verification and a busy
verifier also consume attempts; credentials are not evaluated before admission.

Source identification is accepted only with the server-side Vercel platform
indicator `VERCEL=1` and one valid `x-vercel-forwarded-for` address. Vercel's
[request-header documentation](https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for)
describes this platform forwarding header; arbitrary `X-Forwarded-For`, `X-Real-IP`,
or caller-supplied platform claims are ignored. IPv6 spellings are canonicalized.
Malformed, missing, multi-address, or non-Vercel sources receive global protection
only. This is an explicit source-limit limitation for local HTTP/other hosts,
not permission to trust their forwarding headers. Review any custom trusted-proxy
configuration before relying on source limits at activation.

Source identifiers are scoped HMAC-SHA-256 digests using the private configured
key; plaintext addresses are not persisted or logged. Global identity is also
stable and scoped. Rotating the HMAC key changes bucket identities, so key changes
must be coordinated across instances and must not be used to evade active limits.

Atomic upsert results decide admission under concurrency; a preliminary read
alone never grants capacity. Over-budget cooldown ends at the existing window
deadline, and denied traffic cannot move that deadline forward. Database-derived
remaining seconds determine `Retry-After`, independent of application clock skew.
The only foundation changes add those returned durations and a window-end
cooldown option; no schema or migration changes are needed.

A nonblocking PostgreSQL transaction advisory lock `(824101,1)` serializes
expensive HTTP credential verification across application instances. A busy
request receives `429` with a one-second retry. The lock is scoped to the database,
is held while verification runs, and releases on transaction end/connection loss;
no in-memory authorization state or queued KDF backlog is used. This consumes one
database connection during derivation, a deliberate resource trade-off to verify
in Vercel sizing. Database failures never bypass limits or create synthetic sessions.
The existing cleanup exports remain available for a future trusted maintenance job.

## Validation and remaining boundaries

Run `npm run test:unit` and `npm run test:auth-db`. The database command includes
foundation, authentication-service, and API-authorization tests in sequence. It requires an
explicit `CR8OR_AUTH_TEST_DATABASE_URL` pointing only to disposable local
PostgreSQL on port 55432/database `cr8or_auth_test`; it never falls back to the
application connection. Each suite creates/removes its own schema and uses public
synthetic credentials. Do not run two copies of the private-service suite
concurrently against the same test database because verification capacity is
database-wide. The integration suite also tests the real operator CLI's status
path without provisioning a production owner.

Run `npm run test:auth-boundary` after installing dependencies and generating
Prisma. It builds temporary Next.js applications that attempt to import the actual
credential, owner-management, and execution-context modules into Client Components. A probe passes
only when Next.js rejects the import at the `server-only` boundary; unrelated
build failures and timeouts fail the check. No credential or database operation is
invoked, and the temporary applications are removed afterward.

Production activation remains pending: review trusted agent project authorization,
add frontend locking, verify origin/cookie behavior and recovery,
review rate limits and source trust on the deployment, schedule cleanup, verify
database role restrictions, and protect all deployment URLs before the Phase 1A-5
cutover. Protected handlers now validate cookies against PostgreSQL in private
mode; AI entrypoints now require the Phase 1A-3B execution context. Unsupported
runtime commands, previews, and provisioning remain unavailable in private mode.

The [Phase 1A-1 dependency findings](reviews/phase-1a-1-dependency-review.md)
remain separate and unresolved; no unrelated updates or removed audit gates are
part of this change. The known GitHub Actions account restriction is not a local
code-validation result and was not investigated or bypassed.

Future passkeys must use server-side WebAuthn verification and the stable stored
owner handle before creating a `PASSKEY` session. No client-provided biometric
claim, registration, invitation, multi-user onboarding, or public recovery path
is supported by this stage.
