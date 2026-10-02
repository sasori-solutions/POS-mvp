## PIN email recovery — prepared, not deployed

Agente de Larios, 1 October 2026. Migration 0007, standalone Edge and frontend are verified locally. Sender configuration for the user-supplied larioscow.dev is pending. Do not describe production as running this feature until sender, migration, account and frontend are activated together. See docs/pin-email-recovery.md.

# Public PWA deployment on Cloudflare Pages

Agente de Larios · 1 October 2026.

The frontend is a static Vite PWA. Supabase project `sdisalomdxgejyhpxtri` remains the Auth, account API, and Postgres backend. Hosting the frontend does not move or replace that backend. No Pages Functions are required for this slice.

The current public host is **[pos-mexico-mvp.pages.dev](https://pos-mexico-mvp.pages.dev)**. The Pages project uses Direct Upload; upload the verified build for each release. Pushing the repository alone does not update this deployment.

Current employee invitation correction, 1 October 2026, Agente de Larios: production **`174c4310-c35b-4c74-87cd-cde2be13dd6a`** publishes the verified 20-file frontend with `index-BQvTqgkV.js`. Release ZIP: 309,851 bytes, SHA-256 `99054725a86958f3060a93c182fc67d84a3be02f5933ebaae0ba0f6bb0b01b47`. The public route/asset gate passed **27/27** against local `dist`.

Adding an employee now uses one Google invitation flow. Native role choices show included and restricted navigation sections; the Google checkbox is removed. Creation leads to a focused share screen with Copiar enlace. Recipients see an invitation-specific login and do not re-enter the invitation code once its details load. Existing PIN-only employees, PIN ownership and backend policies remain supported. No backend/schema deployment was needed.

Validation: **170/170 desktop/mobile browser cases**, production build/typecheck and the real local browser/Auth/Edge/Postgres smoke passed. The smoke covers new invitation creation/acceptance with employee-selected PIN and legacy PIN-only compatibility; synthetic identities were cleaned. This does not claim physical-phone installation, fresh Google consent or authenticated production employee mutations. Existing app windows may need to close/reopen to adopt the current worker.

Historical Más navigation correction, 1 October 2026, Agente de Larios: user-approved Cloudflare production **`c45a4597-3627-4f1b-a96a-830d0f58b45a`** publishes the verified **20-file** build, including `index-BfEQlhb1.js`. Release ZIP: 308,566 bytes, SHA-256 `833763b1722a276f5585e0bcbc304ad971131fa771769164e2dfecf415ebc69f`. Public route/asset checks passed **27/27**, matching local `dist` exactly.

Más now groups Negocio, Mi acceso and Sesión in navigation rows. Employee and register-device management open directly; returning restores Más and its focused entry. Business settings use labelled groups and preserve the form after saving. Employee PIN authorization, optional Google access and device pairing use specific labels and separate instructions. Unlinking a register device requires confirmation. Existing backend, migrations and access policies remain unchanged.

Validation passed **166/166 desktop/mobile browser cases**, production build/typecheck and the real loopback browser/Auth/Edge/Postgres smoke without response mocks. The smoke covered employee PIN setup and Google linking, deletion/restoration, device pairing/revocation and owner PIN change/recovery; synthetic fixtures were cleaned. Physical-phone installation and authenticated cloud mutations were not repeated. Existing app windows can retain the previous worker until all app windows are closed and reopened.

Historical access UI correction, 1 October 2026, Agente de Larios:  Cloudflare production `e88f5deb-077f-419b-af15-1f366dd398d9` publishes the verified 20-file frontend with `index-Blvjyc9v.js` and `TeamPanel-CmKoL-DT.js`. Release ZIP SHA-256 `f4aaa7ab621f95d480774dd0caeb3ba831fda85e716ce9494469d7dbae80fbfc`, 306,552 bytes. Public route/asset verification passed **27/27** against local `dist`.

The correction places Cambiar PIN inside the same action layout as its siblings, restoring equal widths and gaps on desktop and phone. Más groups business settings, personal PIN actions and session actions. The recovery entry is named Recuperación de mi PIN and explains the independent code. Employee creation names Google as optional personal access, describes when a PIN alone suffices and associates that explanation with the checkbox. No database, Edge, auth logic, recovery policy or employee permissions changed.

Validation passed **162/162 desktop/phone-width browser cases** and frontend typecheck/build. The new layout regression first reproduced the wrong PIN-button width on both sizes and then passed after the fix; it also confirms the logout button is reachable above the fixed navigation after scrolling. Screenshots use synthetic local data. Integration verification covered all 57 existing cases: 54 passed in a serial full-suite run and the three five-second timeouts passed in a targeted rerun with a 30-second limit. The initial parallel run under the current local runtime also timed out in account, business-team, unified-employee, owner-recovery and employee-lifecycle suites and one cleanup failed; its leftover synthetic identity was cleaned. No app/server timeout or test source timeout was changed. Hosted authenticated UI/PIN mutations and physical-phone installation were not repeated for this frontend correction. Other existing windows may keep an older PWA worker until closed/reopened; the hosted byte checks use the current network build.

PIN policy and recovery backend release, 1 October 2026: migrations `20261001000500_employee_pin_policy.sql` and `20261001000600_owner_pin_recovery.sql` and the checked `account` function are deployed to Supabase project `sdisalomdxgejyhpxtri`. Previously applied 0001–0004 remain unchanged. The canonical six-entry ledger contains **44/48/27/23/29/21 statements**. Cloud/local comparison found no differences across **46 SQL functions**. All **18 private tables** have RLS and deny browser access; all **nine public account RPCs** deny browser execution and grant the service role. The downloaded **30,824-byte** standalone Edge source matches the checked artifact byte for byte, SHA-256 `5bb1d8d85dd531cab0577b02dda23c433a7e605dc980a1a426d83b9e42021679`.

Cloudflare production deployment **`4332457e-e8b5-4ad2-8bcd-85a847714eb8`** publishes the **20-file** release ZIP, SHA-256 `5c5aa7080156f339302e24ec7ef02468da34c28b1881dbf85ef7fd8e1c9aea28`, including `index-DyQATu0Q.js`. Anonymous public route/asset checks passed **27/27**, matching the verified build. **20/20 anonymous cloud API probes** passed with exact-origin CORS and no-store responses, including the current employee PIN authorization, invitation-details, owner recovery and current-PIN-change parser/error boundaries. These probes performed no authenticated employee, PIN, invitation, recovery or device mutations.

Final local validation passed **160/160 desktop/phone-width Playwright cases**, **57/57 real Auth/Edge/Postgres integration tests without skips**, **16/16 Deno validation/authentication tests**, typechecks, build and independent reviews. The real local browser smoke passed without response mocks and cleaned its synthetic fixtures; it covers employee-selected PIN setup, preservation on Google linking, current-PIN changes, independent owner recovery, code replacement and operator-session invalidation. The real 0004→0005/0006 compatibility smoke preserved existing people, hashes, counters and pending invitation codes and confirmed legacy owners remain unenrolled. The local production-authentication guard also passed with the password bypass disabled. The active PWA loaded `index-DyQATu0Q.js` after its waiting worker was activated through visible browser developer tools and an ordinary reload. The existing Google identity loaded its business PIN screen; its unenrolled recovery screen blocked a Google-only reset. Fresh real Google selection/callback/status completed and showed create/join for an account without linked businesses, without creating a business. Successful authenticated cloud PIN/staff/recovery/device mutations, fresh cloud business creation and physical-phone installation remain unverified. No human PIN or recovery code was entered, generated or recorded. Other installed windows may retain an older worker because no update banner is implemented.

Historical employee lifecycle release, 1 October 2026: migration `20261001000400_employee_lifecycle.sql` and its checked `account` function were deployed. The migration transaction guarded the exact applied 0001–0003 history; the four canonical ledger entries contained **44/48/27/23 statements**. Ten changed SQL function bodies matched that source. All 14 private tables had RLS and denied browser access; all 23 private helpers denied browser execution, and all nine public account RPCs denied browsers while granting the service role. The downloaded **26,669-byte** Edge source matched that standalone artifact byte for byte, SHA-256 `28e973733f8c783a530061b29bd96deb51f5bc6d03715ea4a8627e77e57397df`.

That historical Cloudflare production deployment **`6cb52946-9921-4b92-b552-a3f282b225d2`** published 20 files from its verified release ZIP, SHA-256 `228323e6168f11bfc57809b0561b838de9a124be7dfc8a39901ce43c19ccd0bf`. Its build included `index-BSzhioHG.js` and `TeamPanel-C7wE4MFL.js`. Public route/asset checks passed **27/27** against that build. Eight anonymous cloud probes passed with exact-origin CORS and `Cache-Control: no-store`: unauthenticated status, unknown device/pairing credentials, optional-Google creation, targeted invitation, name-free acceptance, employee deletion and restoration. Valid personal requests reached `AUTH_REQUIRED`; no production employee/invitation/device was created, removed or restored for those probes.

That release's final local validation passed **126/126 desktop/phone-width Playwright cases**, **36/36 real Auth/Edge/Postgres integration tests without skips**, **13/13 Deno validation/authentication tests**, typechecks, build and independent review. Its real local browser smoke exercised the focused employee form, invitation outcomes, deletion/restoration and session invalidation without API mocks, then cleaned synthetic fixtures. A separate real local 0003→0004 migration smoke preserved old invitation state, expiry and codes. Real hosted Google selection/callback/account loading reached the existing business PIN screen. The waiting worker was activated through visible Brave developer tools; an ordinary reload subsequently loaded `index-BSzhioHG.js` with the existing Google session. No update banner or security-setting change was introduced. Successful authenticated cloud employee/device mutations, fresh business creation and physical-phone installation remained separate manual checks. Human PIN entry was not automated or recorded.

Historical unified employee correction, 1 October 2026: migration 0003 and the checked `account` function are deployed, with exact 0001/0002 history guards and all three migrations recorded (44/48/27 statements). Nine SQL function source hashes, private RLS and browser/service RPC grants were verified. The downloaded Edge source matches SHA-256 `c581150f7a1a50bd9fd1afa93b4ee38f021308a98ed00d5dc1c17e74891c7882`; six anonymous probes passed, including the new payloads. Cloudflare production deployment `219368ec-e1e8-4b3c-95e0-314b6adb8158` publishes all 20 files; hosted hashes passed 27/27. After PWA worker activation, real Google selection/callback/account loading and authenticated owner Venta/Más/team rendering passed. The live form has one employee creation flow with optional Google and no provisional PIN or global second invitation form. No production employee/invitation was created in this inspection. Successful cloud staff/link/accept/pair mutations, fresh business creation and physical-phone installation remain manual checks. PIN entry was not automated or recorded.

## Build and upload

Use a Cloudflare Pages project with the repository root as its root directory, build command `npm run build`, and output directory `dist`. Use Node 22, at least 22.12; the installed Vite package requires Node 20.19+ or 22.12+. The lockfile defines the npm dependencies. For a local production build, run:

```sh
npm ci
npm run build
```

The production build must receive these **public** values through the host's build environment or the public production env file:

```dotenv
VITE_SUPABASE_URL=https://sdisalomdxgejyhpxtri.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<this project's public publishable key>
```

Vite embeds these values when it builds the JavaScript. Changing host settings requires a new build. Missing settings show the app's preparation screen; there is no automatic localhost backend fallback. Google client secrets, Supabase secret/service-role keys, and database credentials do not belong in frontend env files or build output.

For Direct Upload, select **only the generated `dist` directory**. Do not upload the repository or workspace. Tests, env files, backend source, and private notes live outside `dist`; no extra deployment-ignore file is needed for this build. Before uploading, confirm the directory contains only the generated shell, hashed assets, icons, manifest, and worker files.

The Cloudflare account must be signed in and its required account steps completed before a Pages project can be created. Choose a stable public HTTPS Pages URL; no custom domain is required. Keep production publicly reachable so merchants can open the app and start Google sign-in.

## Routing and OAuth

Use Pages' native SPA fallback: keep both `_redirects` and a top-level `404.html` out of the deployment. Unknown routes receive the app shell while retaining their pathname and query. This preserves `/auth/callback?code=…` for the app's PKCE exchange and leaves real assets reachable. Explicit 200 proxy rules targeting `/index.html` produced 308 redirects to `/` on the live host, losing the callback pathname; they have been removed. Pages canonicalizes HTML file URLs. [SPA serving](https://developers.cloudflare.com/pages/configuration/serving-pages/).

The existing cloud configuration is:

- Supabase Auth **Site URL**: `https://pos-mexico-mvp.pages.dev`.
- Supabase Auth **Redirect URLs**: only `https://pos-mexico-mvp.pages.dev/auth/callback`.
- The cloud account Edge Function's `ALLOWED_ORIGINS`: `https://pos-mexico-mvp.pages.dev` without a path.
- The Google Web OAuth client's authorized JavaScript origins: only `https://pos-mexico-mvp.pages.dev`. Its authorized redirect URI remains `https://sdisalomdxgejyhpxtri.supabase.co/auth/v1/callback`.

Start a fresh Google login from the public app after these changes. Localhost and the public hostname have different browser storage, so an OAuth attempt started locally cannot be resumed at the public origin. Use exact production callback URLs rather than broad preview wildcards. [Supabase redirect configuration](https://supabase.com/docs/guides/auth/redirect-urls), [Google provider setup](https://supabase.com/docs/guides/auth/social-login/auth-google).

Local testing uses the separate local Supabase instance, `supabase/config.toml`, and `.env.functions`; it does not need localhost origins on the production cloud project. Remove obsolete localhost origins from the production Google client's JavaScript origins as well.

## PWA behavior and release checks

The manifest starts at `/` with scope `/`, standalone display, and 192/512-pixel icons. The worker precaches the static app shell and uses `index.html` for navigation fallback. It has no runtime cache for Supabase Auth or account responses; business access still requires a network connection. Pages' default browser caching revalidates assets, so no custom long-lived cache rule or `_headers` file is needed here. [Pages cache behavior](https://developers.cloudflare.com/pages/configuration/serving-pages/).

The current worker uses prompt-style updates but has no update banner. Existing installed windows can keep the previous cached shell, including after an ordinary navigation or Google callback. During the lifecycle release, visible browser developer tools activated the waiting worker, and an ordinary reload confirmed the current bundle. This inspection does not establish automatic or immediate updates for other installations. Check the active hashed bundle when verifying a release; adding an explicit update prompt remains a frontend improvement.

Before calling the public deployment ready:

1. Open the HTTPS URL in a fresh browser without a Cloudflare account. Confirm the app loads and does not require a hosting login.
2. Directly open and reload all seven SPA paths: `/login`, `/business/new`, `/business/ready`, `/unlock`, `/join`, `/employee`, and `/auth/callback?error=access_denied`. Each must serve the app shell; the denied callback should show the app's Google error message. Private home and ready routes must still require a valid operator session.
3. Fetch `/manifest.webmanifest`, `/sw.js`, the actual hashed JS/CSS paths, and both icon files. Confirm each serves its own expected content, not `index.html`.
4. Confirm the built bundle uses the expected cloud Supabase URL. An unauthenticated account POST with the public app origin should return `AUTH_REQUIRED`, not `ORIGIN_FORBIDDEN`.
5. Complete Google consent, callback exchange, and account loading from that public origin with the human's authorized account. Then verify business creation, PIN unlock, lock, reload requiring PIN, and logout. Existing mocked browser tests do not establish this live OAuth result.
6. Check PWA installation and shell reopening on a phone; verify that unavailable networking does not unlock or create business access.

After building and deploying the same `dist`, run the anonymous HTTP gate with the explicit public HTTPS origin:

```sh
npm run check:live -- https://pos-mexico-mvp.pages.dev
```

It checks the root and all seven exact SPA paths return HTTP 200 without redirects, validates every generated asset's content type, and compares public response hashes with the local build. The current 20-file build produces 27 checks (eight shell routes plus 19 non-index assets). It sends only anonymous GETs; it does not test CORS, sign in, or verify Google consent. Complete the live Google flow before the next GitHub push.

Historical home release: 21/21 hosted route and asset checks, 44 desktop/mobile browser tests and production typecheck/build passed. That release's live bundle was verified in Brave after closing app windows to activate the new worker. The human's existing PIN opened Venta; Ver productos, Más with saved business details and navigation back to Venta also passed live. The preceding auth release passed eight anonymous cloud API checks, real Google login/logout/relogin/reload, an existing PIN unlock and live lock, plus 11 real local database integration tests. The home release changes no backend code or schema; database integration tests were not rerun. Fresh cloud business creation and physical-phone installation remain separate manual checks.

During the preceding business/team release, the business creation form was inspected live with its optional address/contact fields expanded; no production business was created for that inspection. A downloaded copy of the deployed `account` function matched the checked standalone source byte for byte (SHA-256 `bff27bb98eb7b46163847390ba4a856cd2172e791b30dcf172a92ab20cf5c168`).
