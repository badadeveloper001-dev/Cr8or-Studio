# ADR 0001: Auth and Session Model

Status: Accepted
Date: 2026-08-05
Updated: 2026-10-15

## Context

Cr8or Studio is a private workspace for one owner, who may use several devices.
It does not require public registration, invitations, or a multi-user role model.
Authentication is being introduced incrementally; adding persistence alone must
not lock the owner out of the existing application.

## Decision

Use a privately provisioned singleton owner, server-side access-code
verification, and opaque database-backed sessions. Passkeys will be enrolled by
the authenticated owner in a later stage. Preserve project authorization as a
separate boundary, including when AI agents execute tools.

Task 1A-1 implements the database and persistence foundation only:

- PostgreSQL enforces a single `OwnerCredential` with the stable ID `owner`.
  A stable random 32-byte user handle supports future WebAuthn enrollment.
- `AuthSession` stores SHA-256 digests of random 256-bit tokens, never raw tokens.
  Expiration, revocation, and the owner's current credential version are checked
  on lookup without cross-request authorization caching.
- Session creation checks the caller's verified credential version while locking
  the owner row. Revoking all sessions increments that version, so pending work
  that verified an earlier generation cannot create a replacement session.
- `AuthRateLimit` persists source and global attempt windows using atomic
  PostgreSQL updates. Future unlock code chooses and enforces the policy.
- All new authentication tables enable RLS without public policies and revoke
  `PUBLIC` table privileges. The trusted runtime uses the table owner or an
  explicitly authorized `BYPASSRLS` role with table privileges; any separate
  nonowner server role requires reviewed server-specific policies. Verify
  browser-role restrictions before provisioning real credentials.
- Migrations run through `npm run db:migrate` as an explicit release operation,
  never during Prisma helper initialization or ordinary requests.

The full contracts and activation prerequisites are documented in
[the authentication foundation guide](../private-authentication-foundation.md).

## Consequences

- The database can contain zero owners before trusted provisioning and at most
  one owner afterward. No public account-creation path is introduced.
- Multiple owner devices can have independent sessions. Individual revocation
  leaves other sessions valid; revoke-all invalidates the entire generation.
- Credential rotation must update the hash, increment the version, and revoke
  sessions in one transaction on the owner row. Rotation and provisioning are
  intentionally unimplemented in Task 1A-1.
- Database failures reject persistence operations. There is no authentication
  fallback in the new stores.
- Existing authentication flags, middleware, API routes, and frontend behavior
  remain unchanged in this foundation stage. Its delivery does not secure or
  activate the eventual private authentication flow.

## Follow-up

- Add private credential provisioning and secure access-code verification.
- Add the branded lock screen, server-validated HTTP-only cookies, lock/logout,
  and application-level rate-limit policy.
- Enforce session and project authorization at protected API/runtime boundaries,
  including agent tool execution.
- Validate deployment readiness and recovery before mandatory authentication.
- Add owner-only passkey enrollment and authentication in the subsequent stage.
