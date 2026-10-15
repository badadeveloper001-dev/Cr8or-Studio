# Phase 1A-1 dependency vulnerability review

Assessment date: 2026-10-15 UTC. This is a remediation proposal, not approval to
upgrade dependencies. No package manifest, lockfile, or installed dependency
version was changed during this investigation. No `npm audit fix` was run.

## Audit results and origin

Actual npm audit executions against the same registry advisory snapshot returned:

| Input | Critical | High | Moderate | Total |
| --- | ---: | ---: | ---: | ---: |
| Main baseline `18feb13a13e76a10f70d416b402f88a66669558f`, original manifests copied to an isolated temporary directory | 2 | 20 | 6 | 28 |
| PR reference `8bd8b3d6124d1555a1c74cce20365ecf6b11dc8d`, also the correction's unchanged dependency graph | 2 | 21 | 6 | 29 |
| PR graph with `npm audit --omit=dev` | 2 | 19 | 4 | 25 |

Each audit exited 1 because vulnerabilities were found. These are affected
package entries, including parents reported through vulnerable dependencies;
they are not 29 independent exploitable application vulnerabilities.

The sole additional affected package entry is **`@daytona/sdk`**. Main already
declared it in `package.json`, but its lock entries were missing. PR #2 added
150 lock entries (the SDK's missing graph plus `server-only`) and removed none.
Every previously locked package version is unchanged. All 28 baseline affected
entries remain at their baseline versions; `server-only` has no reported finding.
The Daytona entry inherits the already-present `fast-glob` → `micromatch` →
`braces` finding. It is newly visible in the corrected lockfile, not a newly
introduced application feature. Because main's lockfile was incomplete and
failed `npm ci`, its 28-item audit is not proof of a complete or safe historical
installation.

The 25 production-install entries need reachability analysis. `shadcn` is listed
as a production dependency even though it is a CLI; its MCP/Express dependencies
therefore survive `--omit=dev`. Prisma is declared as a development dependency
but is also retained in the production graph through dependency/peer resolution.
Neither installation classification alone establishes request-time exposure.

## Affected packages and patch targets

**D** means direct dependency in `package.json`; **D-dev** means direct
development dependency; **T** means transitive. Installed versions below are
from the lockfile and installed tree. Ranges are the current npm advisory or
aggregate parent ranges. A parent finding may have no advisory against its own
code. Patch targets address the listed advisories, not all possible future
advisories or compatibility requirements.

The named patch versions below were confirmed published through read-only npm
registry queries, except where a row explicitly says a compatible parent
remediation has not been established. Compatibility still requires a separate
lockfile change and validation.

| Package / relationship | Severity | Installed vulnerable version(s) | Reported affected range | Proposed patch or disposition |
| --- | --- | --- | --- | --- |
| `next` — D | Critical | `15.5.22` | Relevant 15.x advisories: `<15.5.24` for the two RCE reports; `>=15.0.0 <15.5.27` for cache issues | At least `15.5.27` on the 15.x line, with separate verification of bundled/transitive dependencies. |
| `proxy-addr` — T | Critical | `2.0.7` | `>=1.1.0 <2.0.8` | `2.0.8`; inspect the `shadcn` → MCP → Express chain. |
| `@daytona/sdk` — D | High | `0.214.0` | Aggregate `<=0.224.1`, through `fast-glob` | No compatible remediation established by audit (`fixAvailable: false`); track the upstream glob-chain fix. |
| `@modelcontextprotocol/sdk` — T | High | `1.30.0` | `>=1.12.0 <1.31.0` | `1.31.0`; review OAuth behavior when updating its parent CLI. |
| `@next/eslint-plugin-next` — T | High | `15.5.22` | Aggregate `>=14.3.0-canary.0` | Inherits the glob-chain finding; no approved compatible fix established. Do not accept the suggested Next ESLint downgrade blindly. |
| `@prisma/config` — T | High | `6.19.3` | Aggregate `6.13.0-dev.1–7.10.0`, plus affected 8.1 development builds | Upstream `deepmerge-ts` fix; audit proposes Prisma `7.10.1`, which requires a separate major-version review. |
| `@ts-morph/common` — T | High | `0.27.0` | Aggregate `0.2.0–0.24.0` or `0.26.0–0.27.0` | Update through a reviewed `ts-morph`/`shadcn` graph that removes vulnerable glob paths; compatible target not established here. |
| `brace-expansion` — T | High | `1.1.18`, `5.0.9` | Aggregate `<=1.1.20` or `>=4.0.0 <5.0.12` | `1.1.21` for the 1.x branch and `5.0.12` for the 5.x branch. This is distinct from the unresolved `braces` package. |
| `braces` — T | High | `3.0.3` | Advisory `<=3.0.3`; npm aggregate `*` | No verified compatible fix in this review; avoid exposing deeply nested untrusted glob patterns and track upstream remediation. |
| `deepmerge-ts` — T | High | `7.1.5` | `<8.0.0` | `8.0.0`; update through a compatible Prisma release rather than forcing a transitive major override. |
| `eslint-config-next` — D-dev | High | `15.5.22` | Aggregate `>=14.3.0-canary.0` | Inherits plugin/glob findings. Audit suggests `14.2.35`, a downgrade that is not an approved remediation. |
| `fast-glob` — T | High | `3.3.1`, `3.3.3` | Aggregate `*` | Inherits `micromatch`/`braces`; no approved compatible parent fix established. |
| `fast-uri` — T | High | `3.1.5` | Aggregate `>=3.0.0 <3.1.8` | `3.1.8`, covering the current URI normalization advisories. |
| `js-yaml` — T | High | `4.3.1` | `>=4.0.0 <4.3.2` | `4.3.2`. |
| `micromatch` — T | High | `4.0.8` | Aggregate `>=0.2.0` | Inherits `braces`; no approved compatible fix established. |
| `nanoid` — T for affected copies | High | Nested `3.3.16` copies | `<3.3.18` | `3.3.18`; the app's direct `nanoid` 6.x dependency is not the reported copy. |
| `postcss` — T for affected copy | High | Next's nested `8.4.31` | `<=8.5.22` | `8.5.23`; verify Next's dependency constraints rather than assuming a top-level update replaces the nested copy. |
| `prisma` — D-dev | High | `6.19.3` | Aggregate `6.13.0-dev.1–7.10.0`, plus prereleases | Audit proposes `7.10.1`; major Prisma/client compatibility and deployment review required. |
| `shadcn` — D | High | `4.16.1` | Aggregate includes `>=2.0.0` and older releases | Resolve CLI graph separately. Audit's `1.0.0` downgrade is not an approved fix; consider development-only placement/removal only after usage review. |
| `sharp` — T | High | `0.34.5` | Current advisories through `<0.35.5` | `0.35.5` addresses the listed native-library advisories; check Next's optional dependency range and runtime compatibility. |
| `source-map-js` — T | High | `1.2.1` | `>=1.0.0 <1.2.2` | `1.2.2`. |
| `ts-morph` — T | High | `26.0.0` | Aggregate `6.0.1–23.0.0` or `25.0.0–26.0.0` | Inherits common/glob findings; reviewed upstream parent update needed, target not validated here. |
| `undici` — T | High | `7.29.0` | Aggregate `>=7.0.0 <7.29.1` | `7.29.1`, covering the current WebSocket, TLS, retry, decompression, and caching reports. |
| `@vitest/mocker` — T | Moderate | `4.1.10` | `>=2.1.0 <4.1.11` | `4.1.11`, updated together with Vitest. |
| `hono` — T | Moderate | `4.12.34` | Current advisories `<4.13.7` | `4.13.7`. |
| `ip-address` — T | Moderate | `10.4.0` | Current advisories `<=10.7.0` | `10.7.1`. |
| `postcss-selector-parser` — T | Moderate | `7.1.4` | `<7.1.6` | `7.1.6`. |
| `qs` — T | Moderate | `6.15.3` | Aggregate `>=2.2.5 <6.16.0` | `6.16.0`. |
| `vitest` — D-dev | Moderate | `4.1.10` | Relevant advisory `>=2.1.0 <4.1.11` | `4.1.11`; preserve ordinary non-public test execution. |

## Production impact and remediation order

1. **Review the Next.js runtime update first.** Next is the application's HTTP
   framework and `sharp` is its optional native image dependency. The reported
   Windows-hosted RCE does not match Vercel's Linux runtime, but remains relevant
   to Windows self-hosting. The other critical report concerns AVIF image
   optimization. This repository has no `next/image` use or explicit AVIF
   configuration in `src`/`next.config.ts`; that lowers demonstrated reachability
   but does not prove the framework endpoint is inaccessible. The two later
   cache-poisoning reports also need deployment-specific evaluation. Propose a
   targeted 15.x update and confirm the resulting nested PostCSS and sharp
   versions; do not assume Next's own patch makes the whole graph clean.
   Registry metadata for `next@15.5.27` still pins `postcss@8.4.31` and allows
   optional `sharp` versions `^0.34.3 || ^0.35.4`. A Next update alone therefore
   does not address the nested PostCSS findings, and the actual sharp lock entry
   must be checked rather than assuming it advances to `0.35.5`.
2. **Patch runtime HTTP dependencies in a separate reviewed change.** Installed
   dependency inspection shows `@ai-sdk/anthropic` →
   `@ai-sdk/provider-utils` → `undici@7.29.0`; the application imports Anthropic
   integration in `src/lib/agents/llm.ts`. The reported HTTP/TLS/WebSocket risks
   depend on which optional features are exercised, but this is a real runtime
   path. Propose `undici@7.29.1` through compatible dependency resolution and
   validate provider streaming, retries, and error handling.
3. **Resolve the CLI/MCP/Express graph and its critical finding.** The observed
   chain is `shadcn` → `@modelcontextprotocol/sdk` → `express` → `proxy-addr`.
   The advisory concerns IPv4-mapped IPv6 handling under proxy trust settings,
   which could undermine IP-based trust or limiting in a reachable Express
   service. No application JavaScript/TypeScript imports of Express or the MCP
   SDK were found, and the application serves through Next. `shadcn` supplies a
   build-time stylesheet import (`shadcn/tailwind.css`) in `src/app/globals.css`;
   removal or reclassification must preserve that stylesheet. Direct production
   exploitability of the Express/MCP chain was not established. The same CLI graph includes Hono, `qs`,
   `ip-address`, `fast-uri`, YAML/CSS parsing, and MCP OAuth exposure. Review
   whether the CLI needs to ship at all, then update reachable tool dependencies;
   moving a package to devDependencies alone does not repair its vulnerabilities.
4. **Review shared glob and build-tool risks.** Daytona is imported by the
   workspace providers, so its glob-chain finding should not be dismissed as
   purely development tooling. Actual risk depends on whether untrusted patterns
   reach those utilities. ESLint, shadcn, and ts-morph share related findings.
   Deepmerge/Prisma concerns recursive merge input; PostCSS/source-map reports
   concern processing attacker-controlled CSS/maps, making build inputs relevant
   in a software-development workspace. Prefer upstream compatible fixes and
   bounded inputs; do not accept audit's proposed framework/CLI downgrades or a
   Prisma major upgrade without review.
5. **Apply the focused Vitest patch when approved.** The mocker advisory concerns
   file access through mock-server redirects. Current checks use `vitest run`
   locally, with no exposed test server. Update Vitest and its matching mocker
   together and rerun tests.

No exploit attempt was made and deployed server bundle reachability was not
proven. Vercel preview protection reduces unauthenticated access to the tested
URLs but does not replace these updates, protect authorized users from malicious
inputs, or establish the security of production/other deployment URLs.

## Evidence and follow-up validation

Commands used: `npm audit --json --audit-level=moderate` on current and copied
baseline manifests, `npm audit --omit=dev --json --audit-level=moderate`,
targeted `npm ls --all --omit=dev`, lockfile comparisons, source import searches,
and read-only queries to `https://registry.npmjs.org/<package>/<version>`.
No baseline install or package update was performed.

Key upstream advisory references:

- [Next Windows RCE](https://github.com/advisories/GHSA-p293-qw3h-jr36),
  [Next AVIF RCE](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4),
  [Next cache poisoning](https://github.com/advisories/GHSA-4jqv-mc3x-m676),
  [related cache poisoning](https://github.com/advisories/GHSA-mcj8-r9mp-w47p).
- [proxy-addr trust handling](https://github.com/advisories/GHSA-jqcg-44mw-7w3h),
  [MCP OAuth credential disclosure](https://github.com/advisories/GHSA-6qxp-vccf-f47h).
- [sharp/libvips](https://github.com/advisories/GHSA-f88m-g3jw-g9cj),
  [sharp/libheif](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c),
  [sharp/librsvg](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).
- [Undici TLS handling](https://github.com/advisories/GHSA-w293-vg96-wgc3),
  [Undici cached-cookie disclosure](https://github.com/advisories/GHSA-2jfj-6hjv-fm6j).
- [braces recursion](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
  [DeepmergeTS recursion](https://github.com/advisories/GHSA-ggr8-5vv4-36mx),
  [Vitest mocker file access](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).

After owner approval, make each remediation group reviewable, inspect the actual
resolved lockfile and production graph, rerun npm audits and relevant application
checks, and assess any unresolved findings explicitly. The known GitHub Actions
account restriction is separate from these audit results; no workflow or account
settings were investigated or changed during this correction.
