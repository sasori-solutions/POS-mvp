# Public PWA deployment on Cloudflare Pages

Agente de Larios · 1 October 2026.

The frontend is a static Vite PWA. Supabase project `sdisalomdxgejyhpxtri` remains the Auth, account API, and Postgres backend. Hosting the frontend does not move or replace that backend. No Pages Functions are required for this slice.

The current public host is **[pos-mexico-mvp.pages.dev](https://pos-mexico-mvp.pages.dev)**. The Pages project uses Direct Upload; upload the verified build for each release. Pushing the repository alone does not update this deployment.

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

The current worker uses prompt-style updates but has no update banner. A new worker can wait until existing app windows close; reopen the app when checking a new release. Adding an explicit update prompt is a subsequent frontend improvement, not a prerequisite for the first public installation.

Before calling the public deployment ready:

1. Open the HTTPS URL in a fresh browser without a Cloudflare account. Confirm the app loads and does not require a hosting login.
2. Directly open and reload `/login`, `/business/new`, `/unlock`, and `/auth/callback?error=access_denied`. Each must serve the app shell; the denied callback should show the app's Google error message.
3. Fetch `/manifest.webmanifest`, `/sw.js`, the actual hashed JS/CSS paths, and both icon files. Confirm each serves its own expected content, not `index.html`.
4. Confirm the built bundle uses the expected cloud Supabase URL. An unauthenticated account POST with the public app origin should return `AUTH_REQUIRED`, not `ORIGIN_FORBIDDEN`.
5. Complete Google consent, callback exchange, and account loading from that public origin with the human's authorized account. Then verify business creation, PIN unlock, lock, reload requiring PIN, and logout. Existing mocked browser tests do not establish this live OAuth result.
6. Check PWA installation and shell reopening on a phone; verify that unavailable networking does not unlock or create business access.

After building and deploying the same `dist`, run the anonymous HTTP gate with the explicit public HTTPS origin:

```sh
npm run check:live -- https://pos-mexico-mvp.pages.dev
```

It checks that all four exact SPA paths return HTTP 200 without redirects, validates asset content types, and compares public response hashes with the local build. It sends only anonymous GETs; it does not test CORS, sign in, or verify Google consent. Complete the live Google flow before the next GitHub push.

The final hosted route and asset gate passed 20/20 checks. Eight anonymous cloud API checks passed for allowed-origin authentication and rejected origins. Real Google login, logout, a fresh cross-tab login and reload passed on the final build. The human's existing PIN unlocked the business screen, and the live lock request succeeded. The same source passed 40 desktop/mobile browser tests, 11 real local database integration tests, and production typecheck/build. Fresh cloud business creation and physical-phone installation remain separate manual checks.
