# POS México PWA

Authentication MVP: Google identity → business details → confirmed six-digit PIN → private business context. Existing owners choose a business and unlock with their PIN. Reloading the app requires the PIN again. Locking revokes the current operator session; signing out revokes operator sessions for this Google session and clears the local Google identity.

## Cloud app

Open the public PWA at **[pos-mexico-mvp.pages.dev](https://pos-mexico-mvp.pages.dev)**. Cloudflare Pages serves the frontend; the configured Supabase project at `https://sdisalomdxgejyhpxtri.supabase.co` runs Google authentication, the account API and the private database.

`.env.production` contains only the public browser URL and publishable key for this project, so a production build from the repository connects to the configured backend without a local environment file. Google client secrets and server keys stay in Supabase. Build with `npm ci && npm run build` and deploy only `dist/`; see [DEPLOYMENT.md](DEPLOYMENT.md).

## Local development and tests

Localhost is for development and isolated tests. Cloud users open the hosted HTTPS URL above. The production cloud configuration accepts only that hosted origin; use the separate local Supabase stack for local authentication tests.

```sh
npm install
cp .env.example .env.local
npm run dev
```

Set `.env.local` to the intended development backend's public Supabase URL and publishable key. The development server uses port 5173. Missing configuration shows an honest setup message; no demo login or production bypass exists.

```sh
npm run test
npm run build
npm run test:e2e
```

Browser tests mock Google/Supabase network responses and test app behavior. They do not prove a real Google authorization or cloud deployment.

## Supabase and Google OAuth

1. Create a Supabase development project and apply the checked-in migrations and `account` Edge Function. Use the CLI's normal authenticated flow or the dashboard; keep project passwords and server secrets outside browser code.
2. In Google Cloud's Google Auth Platform, create a **Web application** OAuth client. Configure the audience/test users as appropriate. Request only `openid`, `userinfo.email` and `userinfo.profile`.
3. Set the production Google **Authorized JavaScript origins** to `https://pos-mexico-mvp.pages.dev`. Origins have no path. Use a separate client/project for development if needed.
4. Set Google **Authorized redirect URIs** to the Supabase provider callback shown on its Google provider page: `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`. When running a local Supabase stack, its callback is `http://127.0.0.1:54321/auth/v1/callback`.
5. Enable Google in Supabase Authentication → Sign In / Providers and enter the OAuth client ID and client secret there. Never put the Google client secret into a `VITE_` environment variable.
6. Set the Supabase **Site URL** to `https://pos-mexico-mvp.pages.dev`, and allow only the exact app callback `https://pos-mexico-mvp.pages.dev/auth/callback`. The app callback is different from the Google → Supabase callback above.
7. Set the cloud Edge Function's `ALLOWED_ORIGINS` to `https://pos-mexico-mvp.pages.dev`. Local tests use the separate local stack's origins. Do not disable tenant checks to solve a CORS problem.

The frontend uses PKCE and exchanges the callback authorization code once, then removes it from the address bar. The Supabase identity is stored under `pos-mexico-auth`; the operator token and PIN remain in memory. The storage adapter drops Google's provider access/refresh tokens and scrubs previously saved copies. Google authorization scopes do not include Gmail or Drive access. Only business summaries are shown before a successful PIN unlock.

Official setup references: [Google sign-in](https://supabase.com/docs/guides/auth/social-login/auth-google), [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).

## Security and behavior

- Never commit `.env.local`, `.env.functions`, database passwords, service-role keys, OAuth secrets or real user records. Only public Supabase browser settings belong in `VITE_` variables.
- Backend financial/business authorization is separate from a persisted Google session. All account operations go through the typed `account` Edge Function; raw PINs are sent only over the authenticated request and never stored by the client.
- Lock and logout hide the private view immediately and notify other open tabs while revocation completes. New entry stays disabled until that request settles. Reloads and expired operator sessions return to PIN entry. Server PIN lockouts include a countdown and disable immediate retries.
- Logout clears this device even when the network fails and explains when remote revocation could not be confirmed. Network failure never creates a local operator session.
- A logout cancels any pending OAuth callback, removes this app's PKCE verifier keys and revokes a late returned Supabase session. Late authentication events cannot restore the private view after logout.
- An already-revoked Auth session confirms repeated logout. A logged-out tab stays closed while a fresh Google login in another tab survives; delayed cleanup preserves newer sessions and PKCE verifiers.
- The PWA caches the application shell and local font. Authentication/account responses are fetched without caching. Business mutations require an online backend; this slice does not implement offline POS sales.

## Design source

Alpha v3 reference: black/white, local IBM Plex Sans, the same functions on phone and tablet, 420px authentication forms, concise Spanish controls. See the local design system and reference read. This implementation includes only business/access setup, not catalog, sales, payments, inventory or invoicing.

## Hosted release status

Supabase project **POS México** (`sdisalomdxgejyhpxtri`) has its canonical schema applied in an atomic SQL transaction and the `account` Edge Function deployed. The function's legacy JWT gateway verification is disabled because the handler verifies the authenticated user and the live Supabase auth session itself; tenant and PIN checks remain in the backend. Its Site URL, sole app callback and allowed API origin now use the hosted HTTPS app. Obsolete localhost entries were removed from the cloud project and Google client.

The Google Cloud project is `pos-mexico-510316`. Its existing Web application OAuth client uses the hosted JavaScript origin and the Supabase provider callback. The human entered its credentials in Supabase. Real Google login, logout without a warning, a fresh login with the old logged-out tab still open, and reload all passed on the final hosted build. The human entered the existing PIN and reached the private business screen; the live lock action also completed successfully. Fresh cloud business creation and installation on a physical phone have not been verified in this release.

The production HTTP gate passes 20/20 route and asset checks, including direct `/auth/callback` serving with no redirect and SHA256 comparison against `dist`. Eight anonymous API checks confirm the hosted origin is allowed, unauthenticated requests return `AUTH_REQUIRED`, and localhost/loopback/unrelated origins return `ORIGIN_FORBIDDEN`. Run `npm run check:live -- https://pos-mexico-mvp.pages.dev` against the same production build after each upload. Cloudflare currently uses Direct Upload; a GitHub push by itself does not deploy the frontend.

The final client changes passed 40 desktop/mobile browser tests and 11 real local database integration tests, including duplicate logout, fresh cross-tab login, and cancelled callbacks preserving newer identity/verifier storage. Production typecheck and build passed before the verified upload.

The earlier frontend preview at `http://127.0.0.1:5173` targeted the development cloud through `.env.local`; it did not use a local production database. `.env.cloud` holds that cloud public configuration and `.env.local-stack` preserves the local-stack configuration; both are ignored by Git. Production builds now use the checked-in public `.env.production` settings. Keep server and Google secrets out of the browser environment and shared Drive documents.

Google's documented basic-identity exception allows testing with only name/email/profile identity scopes without a manually managed test-user list: [Google OAuth production readiness](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview). Do not add Gmail/Drive or other sensitive scopes for this access flow.

The cloud schema was applied through the SQL dashboard, so its migration has **not yet been recorded in the CLI migration history**. Before any future cloud `db push`, link the correct project, verify the existing schema, mark the already-applied migration and confirm the history:

```sh
npx supabase link --project-ref sdisalomdxgejyhpxtri
npx supabase migration repair 20261001000100 --status applied --linked
npx supabase migration list --linked
```

These history-repair commands are documented next steps; they have not been executed by this session. Enter any prompted database password privately rather than putting it into shell commands or documentation.
