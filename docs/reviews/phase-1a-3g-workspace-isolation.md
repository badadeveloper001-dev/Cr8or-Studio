# Phase 1A-3G: Workspace isolation correction

Targeted correction on existing draft PR #9, starting from
`1906b3c9a7adc78d64a743b0ede1edc64149fd3c`. No database schema or migration
changes are required. No private operation is released by this change.

## Root cause and correction

The Daytona adapter already calculated restrictive isolation metadata and
required it when creating a sandbox. Existing startup instead accepted matching
resource identity and lifecycle state. Its already-started shortcut could skip
the isolation check entirely. The service and reconciliation path also accepted
an existing resource's matching ID and started state without positive isolation
evidence.

Startup now has three enforcement layers:

1. The service inspects the exact registered sandbox and requires
   `isolationVerified === true` before recording dispatch. It then revalidates
   the initiating PostgreSQL session, approved scope and current registration.
2. The Daytona adapter independently retrieves current metadata by exact ID and
   verifies isolation before start. The authorization callback remains
   immediately before the mutation. A fresh lookup after start must confirm
   exact identity, started state and isolation. An already-started sandbox also
   requires isolation, authorization revalidation and a fresh completion lookup;
   it never triggers a redundant start.
3. The service validates the returned isolation evidence before recording
   completion. The PostgreSQL transaction additionally rejects missing,
   nonboolean or false evidence for any transition to ready. A matching ID and
   state from an injected adapter alone cannot authorize registration.

The isolation policy itself is unchanged: the trusted snapshot and target,
`daytona` user, private visibility, blocked network without allowlists/proxies,
empty environment and volumes, bounded CPU/memory/disk, no GPU or linked
resources, and the required auto-stop/pause/deletion settings must be verified.
Missing metadata fails closed. Evidence comes from the server adapter; no API
request can supply it. Errors remain sanitized.

## Reconciliation and historical shutdown

An uncertain start can be reconciled only with a fresh exact-ID lookup that
confirms both started state and verified isolation. Unsafe or unverifiable
results remain unresolved and keep their reservation. A later explicit
reconciliation may confirm valid evidence under the existing attempt/cooldown
limits; it never repairs configuration or repeats a provider mutation. New
creation retains exact reservation-label, identity and isolation checks.

Authorization to stop a historical resource does not authorize it for private
development. An approved stop still needs a live owner session, unchanged
registration and exact provider identity. It may proceed with legacy network,
environment, volume or snapshot configuration, provided the adapter can verify
the existing non-destructive deletion policy (`autoDeleteInterval === -1` and
no destruction deadline). Unknown or unsafe deletion settings still block the
actual transition. Stop completion/reconciliation requires stopped state and
can only record `stopped`, never `ready`; full development isolation is not a
prerequisite for reducing exposure.

Pre-dispatch rejection records `FAILED`; failure after recorded dispatch retains
`UNKNOWN` (or the durable `DISPATCHED` reservation if error recording fails).
Rejected operations preserve the previous workspace row. No historical ready
rows are rewritten, repaired or remapped. Idempotent successful receipts remain
historical operation results, and read-only state inspection reports physical
state; neither is a fresh isolation attestation or execution grant.

## Validation

Actual local results on Node.js **24.19.0**, npm **11.9.0**:

| Check | Result |
| --- | --- |
| `npm ci` | Passed; no dependency or lockfile changes |
| `npx prisma validate` | Passed |
| `npx prisma generate` | Passed; Prisma Client 6.19.3 |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run test:unit -- --no-file-parallelism` | 2,432 passed in 54 files |
| `npm run test:auth-db` | 502 passed in 10 files |
| `npm run test:execution-auth` | 401 passed in 7 files |
| `npm run test:lifecycle` | 375 passed in 4 files |
| `npm run test:auth-http` | All 7 compiled HTTP scenario groups passed |
| `npm run test:auth-boundary` | All 13 server-only client-import probes passed |
| `npm run build` | Passed; Next.js 15.5.22 production build |
| `git diff --check` | Passed |

Suite counts overlap. The lifecycle suite contains 93 real PostgreSQL
integration cases, 166 controlled SDK adapter cases, 54 HTTP boundary cases and
62 catalogue/release-gate cases. The final complete unit run includes the
additional already-started completion-lookup tests. The known GitHub Actions
account restriction was not investigated or changed.

Tests use disposable local PostgreSQL 16, synthetic sessions and controlled
Daytona adapters. Coverage includes secure and unsafe startup, already-started
resources, network/environment/volume/snapshot/resource metadata, drift between
lookups, session revocation and remapping after preflight, strict completion
evidence, uncertain reconciliation, preserved creation checks, safe shutdown and
unchanged project/workspace/repository/branch identifiers.

## Limits and release status

All private lifecycle, cloning, cloud-write, development-command and Git release
restrictions remain hardcoded and active. No production setting, database,
credential or Daytona workspace was accessed or modified; authentication was
not activated. No new migration or dependency was introduced.

Provider metadata is necessary evidence, not attestation of snapshot contents,
historical credentials or actual runtime/network containment. No live Daytona
compatibility test was authorized or performed. Separately approved isolated
provider verification remains necessary before release. Provider configuration
can change after the final lookup; PostgreSQL authorization and a remote
mutation cannot be atomic. Post-dispatch verification failure therefore remains
uncertain without automatic stop, repair, replacement or retry. The existing
bounded waits and best-effort cancellation limitations are unchanged.

## Changed files

- `src/lib/workspace/private-lifecycle-provider.ts`
- `src/lib/workspace/private-workspace-lifecycle.ts`
- `src/lib/security/workspace-lifecycle-store.ts`
- `tests/unit/private-lifecycle-provider.test.ts`
- `tests/integration/workspace-lifecycle.test.ts`
- `docs/reviews/phase-1a-3g-workspace-lifecycle.md`
- `docs/reviews/phase-1a-3g-workspace-isolation.md`
