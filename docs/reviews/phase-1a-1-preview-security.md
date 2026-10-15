# Phase 1A-1 preview protection review

Reviewed on 2026-10-15 UTC for PR #2, reference commit
`8bd8b3d6124d1555a1c74cce20365ecf6b11dc8d`.

## Observed result

Unauthenticated GET requests to both the PR branch alias and the reference
deployment URL returned HTTP **302 to `https://vercel.com/sso-api`**. Responses
identified Vercel Authentication and did not return the application page.
Requests supplied no authentication headers, browser cookies, or protection
bypass values, and did not follow the SSO redirect.

| URL | Evidence |
| --- | --- |
| `https://cr8or-studio-git-cr8or-ba3ed1-adewunmi-badas-projects-a13081c2.vercel.app` | PR's Vercel bot preview link; unauthenticated GET redirected to Vercel SSO during this review. |
| `https://cr8or-studio-9yjdg9cnt-adewunmi-badas-projects-a13081c2.vercel.app` | GitHub deployment `7104410095` for the reference commit; unauthenticated GET redirected to Vercel SSO at 21:31:27 UTC. |

GitHub's deployment status records the reference preview as successful at
`2026-10-15T21:08:55Z`. Its Vercel inspection page is
[the reference deployment](https://vercel.com/adewunmi-badas-projects-a13081c2/cr8or-studio/JCSFW6RBKmTpoXRBbsYnJFCapTAr).

This verifies that Vercel intercepted the unauthenticated requests to those
two URLs before serving the application. It does not verify every route,
alias, custom domain, older deployment, authenticated user's permissions, or
deployment-protection exception. No application data or backend action was
requested beyond the root document. No bypass testing was performed.

## Settings that require owner verification

Authenticated Vercel project settings were not available in this environment.
The owner should verify the following in the `cr8or-studio` project:

1. Under **Settings → Deployment Protection**, confirm Vercel Authentication
   or the intended protection method covers Preview deployments, including
   deployment URLs and the branch alias.
2. Review protection exceptions, shareable links, automation bypass access,
   and team access. Ensure any allowed access is deliberate and appropriate
   for this private workspace. Do not paste bypass values into this repository.
3. In a signed-out browser without bypass cookies, check the newest PR preview
   after each deployment, plus any custom preview domains or older URLs that
   remain usable. A protected request should reach Vercel's access gate rather
   than Cr8or Studio.
4. Review production protection separately before relying on it; production
   settings and URLs were outside this PR-preview inspection.

The branch alias can move when a new commit builds. The observed result above
is tied to the reference deployment and review time, not a promise about future
deployments. Application authentication remains unactivated, so deployment
protection is an important access boundary while subsequent work is pending.

No Vercel settings, environment variables, or deployment configuration were
changed. No manual deployment was initiated. The known GitHub Actions account
restriction was not investigated or treated as a code-validation failure.
