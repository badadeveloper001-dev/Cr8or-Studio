# Private authentication foundation — Task 1A-1

This document records the foundation stage. The subsequent
[Phase 1A-2 access-code services](private-access-code-authentication.md) reuse these
tables and operations; they remain default-disabled and do not activate workspace
authorization.

Cr8or Studio has one owner and may have several authorized owner devices. This
stage adds PostgreSQL persistence and server-only operations for later
authentication work. It does not activate authentication or change existing
authentication flags, routes, middleware, workspace ownership, or frontend
behavior.

## Database models

The additive migration is
`prisma/migrations/20261015000000_authentication_foundation/migration.sql`.
It creates three tables and two enums without changing existing projects,
workspaces, task records, memory, repository references, or provider workspace
IDs. It inserts no owner or credential.

| Model | Purpose and database constraints |
| --- | --- |
| `OwnerCredential` | The primary key and `id = 'owner'` check allow at most one owner. Stores an encoded access-code hash, positive credential version, unique 32-byte WebAuthn user handle, and creation/update timestamps. |
| `AuthSession` | Stores a unique lowercase SHA-256 token digest, owner foreign key, credential version, authentication method, authentication/creation/expiry timestamps, and optional revocation/last-active timestamps. Expiry must follow authentication and creation. Indexes support owner revocation and expiry cleanup. |
| `AuthRateLimit` | One current window per `(scope, keyHash)`, where scope is `SOURCE` or `GLOBAL`. Stores nonnegative attempts, window boundaries, optional cooldown, cleanup expiry, and creation/update timestamps. Cleanup expiry cannot precede either the window end or cooldown. |

Singleton ownership is intentional: there are no users, invitations, memberships,
or public registration records. The database can remain unprovisioned with zero
owners. The owner ID does not change during credential rotation or future
passkey enrollment. The owner-to-session foreign key restricts owner deletion
and ID updates.

Future trusted provisioning must generate the WebAuthn user handle once using a
cryptographically secure random generator and preserve it thereafter. It must
store a securely encoded password hash, never a plaintext access code. This task
does not implement the passphrase hashing algorithm, create a real credential,
or provide a provisioning command. `ACCESS_CODE` and `PASSKEY` enum values reserve
session metadata; neither authentication method is implemented by these stores.

The migration includes PostgreSQL checks, row-level security, and privileges
that Prisma cannot express directly. Keep that custom SQL when changing the
schema, and use versioned migrations rather than treating `prisma db push` as
an equivalent deployment procedure.

### Database access boundary

All three new tables enable PostgreSQL row-level security (RLS), create no
policies, and revoke table privileges from `PUBLIC`. RLS denies row access to
ordinary nonowner roles even if hosting-platform defaults grant them table
privileges. Existing application tables and their policies are unaffected.

RLS is deliberately not forced. The trusted Prisma server connection must use
the table owner or an explicitly authorized role with `BYPASSRLS` and the needed
table privileges. If deployment requires a separate server role without either
capability, a reviewed configuration must grant only that server role the
necessary table privileges and restrictive role-specific policies. Do not add
public policies or policies for browser-facing roles to make server queries work.

Before provisioning any real owner credential or sessions, verify runtime-role
access and the lack of browser-role access. In a Supabase deployment exposing
the `public` schema, inspect default privileges, role memberships, and direct
grants to `anon` and `authenticated`, and remove unnecessary table privileges.
Browser-facing roles must not own these tables or have `BYPASSRLS`. RLS does not
replace this deployment-specific privilege review, including privileges such as
`TRUNCATE` that do not use row policies. Keep this prerequisite separate from
the later application-authentication activation checks.

## Server-only session operations

`src/lib/security/session-store.ts` imports `server-only` and separates database
persistence from cookies and HTTP handling. These functions are internal server
interfaces, not public endpoints:

| Export | Contract |
| --- | --- |
| `createOwnerSession({ credentialVersion, authenticationMethod, expiresAt })` | Requires the exact credential version that the caller successfully verified and an expiration after database time, at most 12 hours later. Returns `{ token, session }` after inserting the digest and metadata. It does not verify a credential itself. |
| `hashSessionToken(token)` | Validates the canonical 32-byte base64url token format and computes its lowercase SHA-256 hex digest. |
| `resolveOwnerSession(token)` | Hashes a valid token and resolves the corresponding current session. |
| `resolveSessionByTokenHash(tokenHash)` | Resolves a session by digest, checking owner identity, credential version, expiration, and revocation in one database query. |
| `revokeSession(sessionId)` | Idempotently revokes one owner session and returns the updated row count. |
| `revokeAllOwnerSessions()` | Atomically advances the owner's credential version and revokes all unrevoked sessions. Returns `{ revokedCount, credentialVersion }`. |
| `cleanupExpiredSessions()` | Deletes sessions whose expiration has passed and returns the deleted row count. |

Tokens use 32 cryptographically random bytes, giving 256 bits of entropy, and
are returned only to the trusted caller that will later set the browser cookie.
Only the SHA-256 digest reaches the database. Returned session metadata excludes
the digest. SHA-256 is appropriate for high-entropy random tokens; it must not be
used as the access-code password hashing scheme.

Sessions have an absolute maximum lifetime of 12 hours from their persisted
authentication/creation timestamp. Creation reads PostgreSQL time after acquiring
the owner-row lock and rejects expiration values outside that window; it does
not silently shorten an overlong request. Session lookup never extends the
expiration. This boundary does not depend on a browser or application-server
clock. Invalid dates are rejected before opening a transaction.

Session lookup returns `null` for malformed, unknown, expired, revoked, or
obsolete-generation tokens. Database failures throw `SessionStoreError` with a
safe `UNAVAILABLE` code. Creation also reports `OWNER_NOT_PROVISIONED`,
`CREDENTIAL_VERSION_CHANGED`, or `INVALID_EXPIRATION`. Invalid caller arguments
produce validation errors. No database error triggers a synthetic session or
authentication fallback.
The stores do not log credentials or tokens, and they do not cache session
authorization across requests.

### Concurrent verification, revocation, and credential rotation

The future verifier must read and retain the version of the credential it
actually verified. It must not reread a newer version after verification and
attach that version to a result obtained from an older credential.

Session creation locks the singleton owner row with `FOR UPDATE`, compares its
current version with the caller's expected version, and inserts the session in
the same transaction. Revoke-all updates that same row before revoking sessions.
Consequently, a create ordered before revoke-all is subsequently revoked, and a
create using the earlier version ordered after revoke-all is rejected. An
access-code verification already in progress cannot reopen an obsolete session.

`credentialVersion` therefore represents an authentication generation as well as
a hash version: revoke-all advances it even when the encoded access-code hash
does not change. Individual revocation does not advance it.

Future credential rotation must update the encoded hash, increment the version,
and revoke sessions in one transaction that updates/locks the same owner row.
Lookup independently checks the current owner version, so even an otherwise
unexpired session cannot survive a generation change. Rotation is not exposed
by this task. An already authorized external action is not cancelled by these
persistence operations; future request and agent boundaries must revalidate
before subsequent sensitive work.

## Distributed attempt persistence

`src/lib/security/auth-rate-limit.ts` uses PostgreSQL state shared by all Vercel
instances. It does not use process memory for attempt tracking.

- `recordAuthAttempt({ scope, keyHash, windowMs })` atomically inserts or
  increments one identity using `INSERT ... ON CONFLICT`. An expired window
  restarts at one attempt and preserves any cooldown that is still relevant.
- `getAuthRateLimit({ scope, keyHash })` returns the current record with
  database-derived `windowExpired` and `coolingDown` flags, including expired
  state until cleanup removes it.
- `applyAuthCooldown({ scope, keyHash, windowStartedAt, durationMs })` applies a
  cooldown to the still-active window the caller observed. A stale decision
  returns `null`, and a concurrent longer cooldown is never shortened.
- `cleanupExpiredAuthRateLimits()` deletes records only after both window and
  cooldown retention have elapsed.

Window and cooldown durations are bounded from 1 millisecond through 24 hours.
Records expire; this foundation does not introduce a permanent account lock.
Database failures throw `AuthRateLimitStoreError`, and callers must fail closed
when using this store to protect credential verification.

The caller supplies a lowercase SHA-256 identity digest. A digest is not proof
that a source identifier is trustworthy and does not make a predictable IP
address anonymous. Future unlock code must define trusted hosting-platform
source extraction, a consistent global identity, and privacy-aware key
derivation. It must count the applicable source and global budgets, choose
thresholds, and enforce rejection before expensive verification. Those policy
decisions and the unlock endpoint are intentionally deferred.

Both cleanup functions are explicit exports. A future trusted private scheduler
or operator job must invoke them at an appropriate interval. No public cleanup
endpoint or automatic work during module initialization is introduced.

## Controlled migration procedure

`src/lib/db/prisma.ts` only constructs/reuses the Prisma client. Development
reuse remains in place. Importing it never executes shell commands or runs
migrations; ordinary requests do not initialize the database schema.

Before deploying an application version that queries new tables:

1. Review the additive migration and verify backups and recovery access for the
   intended database. Validate it against an isolated database first, including
   preservation of existing project/workspace relationships.
2. Install the reviewed dependencies and generate the Prisma client for the
   release artifact using `npm ci` and `npx prisma generate`.
3. In an explicitly authorized release environment, confirm that `DATABASE_URL`
   and `DIRECT_URL` address the intended database and migration connection.
   Supply connection secrets through protected deployment configuration, never
   committed files or logs.
4. Execute `npm run db:migrate` (`prisma migrate deploy`) once as a controlled
   release step. Confirm successful migration status and trusted runtime-role
   access before promoting the dependent application version. Check restricted
   browser-role access before any future real credential provisioning.
5. Build and verify the application. A missing schema or failed migration must
   stop the dependent release; do not try to repair it inside requests.

`prisma/manual-schema.sql` is a complete bootstrap snapshot for an empty
database. Do not run it against an existing database or use it instead of the
incremental migration. Prefer versioned migrations even for new databases. A
manual bootstrap does not populate Prisma migration history; a deliberate
baseline is required before subsequently adopting Prisma Migrate.

Task 1A-1 does not require production activation or production credential
creation. Its additive migration can precede later authentication work without
changing the current application's authentication behavior.

## Isolated database verification

The authentication integration tests require an explicit
`CR8OR_AUTH_TEST_DATABASE_URL`. Use only a disposable local PostgreSQL database;
the suite must not use the application's production connection. The following
credentials are dummy local-test values:

```bash
CR8OR_AUTH_TEST_DATABASE_URL='postgresql://cr8or_test:cr8or_test_local_only@127.0.0.1:55432/cr8or_auth_test' npm run test:auth-db
```

`npm run test:auth-db` runs `tests/integration/auth-foundation.test.ts`. The
database must already exist, be reachable, and grant its test role the
schema/table privileges needed by the suite. RLS verification also requires
permission to switch to the built-in `pg_read_all_data` and `pg_write_all_data`
roles; the disposable PostgreSQL service in CI uses its local test superuser.
Run these tests only against a
database whose test records and schemas can be discarded. If isolated
PostgreSQL is unavailable, report the integration test limitation; never
substitute production credentials. Unit tests run with `npm run test:unit`.

## Remaining activation work

This foundation adds no credential provisioning, access-code verification,
cookies, unlock/logout endpoints, lock screen, frontend session state, automatic
locking, browser-storage cleanup, passkey enrollment, or AI agent authorization
changes. Existing authentication behavior remains in effect; this stage alone
must not be represented as securing the application.

Before mandatory authentication can be activated, subsequent tasks must:

- Provision the owner privately using a reviewed password-hashing design and
  establish an operator recovery procedure that does not disable authentication.
- Integrate server-validated HTTP-only sessions, origin/CSRF checks, bounded
  brute-force policy, explicit lock/logout, and safe frontend state handling.
- Protect sensitive routes and enforce canonical project authorization through
  agent tool execution, including session revocation during ongoing work.
- Confirm the database access boundary described above was verified before
  owner provisioning. Preserve RLS and trusted server-role access, and verify
  browser-facing roles cannot read or mutate authentication data.
- Verify deployment origins, secure cookies, independent owner devices,
  credential rotation/recovery, private cleanup scheduling, and protection of
  older deployment URLs before changing the authentication flag.

Passkey enrollment must later require an already authenticated owner and fresh
verification, preserving the existing owner ID and WebAuthn user handle. There
is no public registration or multi-user onboarding planned.
