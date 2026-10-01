# Public PWA deployment on Cloudflare Pages

Agente de Larios · 1 October 2026.

The frontend is a static Vite PWA. Supabase project `sdisalomdxgejyhpxtri` remains the Auth, account API, and Postgres backend. Hosting the frontend does not move or replace that backend. No Pages Functions are required for this slice.

The current public host is **[pos-mexico-mvp.pages.dev](https://pos-mexico-mvp.pages.dev)**. The Pages project uses Direct Upload; upload the verified build for each release. Pushing the repository alone does not update this deployment.

Current employee lifecycle release, 1 October 2026: new migration `20261001000400_employee_lifecycle.sql` and the checked `account` function are deployed. The migration transaction guarded the exact applied 0001–0003 history; the four canonical ledger entries contain **44/48/27/23 statements**. Ten changed SQL function bodies match the final source. All 14 private tables have RLS and deny browser access; all 23 private helpers deny browser execution, and all nine public account RPCs deny browsers while granting the service role. The downloaded **26,669-byte** Edge source matches the standalone artifact byte for byte, SHA-256 `28e973733f8c783a530061b29bd96deb51f5bc6d03715ea4a8627e77e57397df`.

Cloudflare production deployment **`6cb52946-9921-4b92-b552-a3f282b225d2`** publishes 20 files from the verified release ZIP, SHA-256 `228323e6168f11bfc57809b0561b838de9a124be7dfc8a39901ce43c19ccd0bf`. The build includes `index-BSzhioHG.js` and `TeamPanel-C7wE4MFL.js`. Public route/asset checks passed **27/27** against the same build. Eight anonymous cloud probes passed with exact-origin CORS and `Cache-Control: no-store`: unauthenticated status, unknown device/pairing credentials, optional-Google creation, targeted invitation, name-free acceptance, employee deletion and restoration. Valid personal requests reached `AUTH_REQUIRED`; no production employee/invitation/device was created, removed or restored for these probes.

Final local validation passed **126/126 desktop/phone-width Playwright cases**, **36/36 real Auth/Edge/Postgres integration tests without skips**, **13/13 Deno validation/authentication tests**, typechecks, build and independent review. The real local browser smoke exercised the focused employee form, invitation outcomes, deletion/restoration and session invalidation without API mocks, then cleaned synthetic fixtures. A separate real local 0003→0004 migration smoke preserved old invitation state, expiry and codes. Real hosted Google selection/callback/account loading reached the existing business PIN screen. The waiting worker was activated through visible Brave developer tools; an ordinary reload subsequently loaded `index-BSzhioHG.js` with the existing Google session. No update banner or security-setting change was introduced. Successful authenticated cloud employee/device mutations, fresh business creation and physical-phone installation remain separate manual checks. Human PIN entry was not automated or recorded.

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
