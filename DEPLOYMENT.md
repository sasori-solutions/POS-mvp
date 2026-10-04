# Production deployment

**Merge a reviewed PR into `main` → Basic checks → automatic Cloudflare deployment → public asset verification.** Opening or pushing a PR runs checks only. There is no routine dashboard upload after merging.

| Component | Source of truth |
| --- | --- |
| Frontend | [Cloudflare Pages production](https://pos-mexico-mvp.pages.dev), project `pos-mexico-mvp` |
| Release result | [GitHub CI runs](https://github.com/sasori-solutions/POS-mvp/actions/workflows/ci.yml), then the Cloudflare job summary for the exact commit |
| Auth, API and database | Supabase project `sdisalomdxgejyhpxtri`; published separately before dependent frontend changes |
| Team process | [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) |

## Automatic path

1. Work in an isolated branch/worktree, open a PR and obtain review from the other developer. Run focused checks for changed behavior. **Basic checks** runs `npm run test:smoke` and `npm run build` (including TypeScript). **Required financial checks** also runs the reusable full workflow for browser, SQL, Edge and integration coverage. Both gates must pass before automatic publication; **Full checks (manual)** remains available for independent investigation.
2. Publish and verify any required compatible Supabase migrations/functions **before merging**. The currently served frontend must continue to work against that backend. If a change cannot be backward compatible, split it into staged changes before merging. Follow the module's migration checks and destructive-operation requirements; this runbook does not authorize data deletion.
3. Merge the reviewed PR into `main`. The push starts CI. CI builds once and retains `production-dist` for one day; the reusable deployment workflow downloads that same artifact. No second build or repeated test suite is run on the automatic path.
4. Deployments share a concurrency group and finish serially. Just before upload, CI compares its commit with remote `main`; obsolete builds are skipped. A skipped run is not evidence that the newer run deployed successfully.
5. Wrangler uploads to production. The HTTP gate compares public routes and every generated asset with `dist`. It allows three attempts, ten seconds apart, for propagation. The release summary reports the commit, Cloudflare deployment ID/URL, and whether upload and verification passed.
6. Report the actual result. **Basic checks passed** means the build passed; **Published and verified** means public frontend bytes matched at verification time. Backend behavior, Google consent and physical-device tests need their own evidence when affected.

The normal publisher is GitHub Actions. Do not upload a local build in parallel or push directly to `main`. Branch protection was reported unavailable under the organization's private-repository plan; review remains the team's operating rule. Do not claim GitHub enforces that rule without checking the current repository settings.

## Production configuration

Settings → Environments → `production`:

| Kind | Name | Value / permission |
| --- | --- | --- |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | The existing Cloudflare account ID |
| Secret | `CLOUDFLARE_API_TOKEN` | Account → Cloudflare Pages → Edit, limited to that account |
| Deployment branch rule | `main` | Only `main` may use this environment |

These names were present during the 2 October 2026 inspection; the successful deployment below confirms they worked for that run. A missing/expired/revoked token is a configuration failure, not a reason to bypass CI. An account owner enters or replaces credentials privately; never paste them into a PR, chat, log, Drive or frontend variable. See [Cloudflare's CI setup](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).

CI uses Node 24 and `npm ci` with the committed lockfile. Cloudflare receives prebuilt `dist`; it does not run a separate Git-integrated build. `.env.production` contains only public browser Supabase settings. Vite embeds those values during the build, so changes require a new build. Google client secrets, service-role keys and database passwords stay server-side.

## Troubleshooting and recovery

| What you see | Meaning and next action |
| --- | --- |
| PR checks are green, site unchanged | PRs do not publish. Review and merge the PR, then inspect its `main` CI run. |
| Basic checks fails | Fix the reported test/build error in the branch. Deployment is blocked. |
| Missing production configuration | Set the named variable/secret in the `production` environment; do not print token values. |
| Deployment skipped as superseded | A newer commit is on `main`. Inspect that newer run. |
| Upload fails or is cancelled | Deployment is unconfirmed. Read the failed step and Cloudflare deployment state before retrying. |
| Upload succeeds, public verification fails | The site may already have changed. Compare the public assets, deployed commit and current `main`; inspect HTTP/propagation errors. Do not call the release verified. |
| Public assets match, existing app still looks old | An open PWA may still use its previous service worker. Finish pending work, close every app window/tab and reopen. Do not clear storage containing pending sales. |

For a failed upload, rerun the failed GitHub job while the checked artifact is retained and its commit is still current. For expired artifacts or a deliberate redeploy of current `main`, run [Deploy Cloudflare Pages](https://github.com/sasori-solutions/POS-mvp/actions/workflows/deploy-pages.yml) using **Run workflow → main**. That recovery path runs `npm ci`, the same smoke/build gate, and the same serialized upload/public verification. Recheck backend compatibility before either retry; do not use the recovery workflow to ship an unmerged feature.

For an application regression, create a revert PR from current `main`, verify compatibility with the already-applied backend, review and merge it. CI publishes the revert normally. Do not rewrite an applied migration or roll back database data blindly. Any exceptional dashboard rollback must be coordinated with the team and ongoing CI, and reconciled with Git afterward.

## Routing, OAuth and PWA

Keep the native Pages SPA fallback: no top-level `404.html` or `_redirects` proxy to `/index.html`. The account callback must retain its pathname/query. The HTTP gate checks root, login, business creation/ready, unlock, join, employee, register, recovery and the denied-OAuth callback, plus assets. See [Pages serving behavior](https://developers.cloudflare.com/pages/configuration/serving-pages/).

Production configuration must keep these values aligned:

- Supabase Site URL and Edge `ALLOWED_ORIGINS`: `https://pos-mexico-mvp.pages.dev`.
- Supabase app redirect URL: `https://pos-mexico-mvp.pages.dev/auth/callback`.
- Google authorized JavaScript origin: `https://pos-mexico-mvp.pages.dev`.
- Google redirect URI: `https://sdisalomdxgejyhpxtri.supabase.co/auth/v1/callback`.

Local authentication tests use the separate loopback Supabase stack. Do not allow broad preview callback wildcards or add development origins to production to make a test pass. See [backend setup](supabase/README.md).

The PWA precaches its shell. The current source uses prompt-style worker updates but has no update banner; publishing successfully does not force an already-open installation to change immediately. Auth/API responses are not cached. Anonymous asset verification does not log in or validate sales, Google consent, email delivery or phone installation.

To compare an exact checked build with production manually:

```sh
npm ci
npm run build
npm run check:live -- https://pos-mexico-mvp.pages.dev
```

Run this from the revision being verified with its production configuration. A different revision's build can correctly fail comparison.

## Observed release — 2 October 2026

This is dated evidence, not a permanent claim about what is live:

- `main` commit: `2c8fd4af508d73059d561d3cfc713192663544ac`.
- [CI run 36974296331](https://github.com/sasori-solutions/POS-mvp/actions/runs/36974296331): Basic checks and Cloudflare publication succeeded.
- Cloudflare production deployment: `6891de1d-c1d8-4ab6-9c12-6185d0aeb60a`; [deployment URL](https://6891de1d.pos-mexico-mvp.pages.dev).
- Fresh local smoke: 9/9 passed; build passed; anonymous production comparison: 35/35 passed against the same application source. No backend migrations, credentials or human account data were changed during this inspection.

Earlier release reports and their original attribution are preserved in [historical deployment notes](docs/history/deployment-before-workflow-cleanup-2026-10-02.md). They do not override this procedure or verify later versions.
