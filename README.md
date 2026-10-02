# POS México PWA

Account and home MVP: a new Google account chooses “Crear mi negocio” or “Unirme a un negocio”. Business creation saves the first branch/register names, payment methods and optional public address/contact, then a confirmed six-digit owner PIN. Existing members choose their business and unlock directly into home. Owners can edit the profile, manage staff and invitations, and pair/revoke devices. Catalog, orders and sales still show availability messages until those modules are implemented.

Shared registers use `/employee`: a one-use pairing code connects a restricted device, then each active employee selects their name and enters their PIN. The device never needs to retain the owner's Google session. Invited employees may also join with their own Google account. Roles come from the owner's assignment; the employee cannot select their own permissions. Reload, lock, employee switch and expiry require PIN entry again. Only the device credential is persisted; PINs and operator tokens stay in memory.

Employees choose their own PIN. The owner assigns name/role and authorizes initial setup, without entering the employee's PIN. Google invitees with no PIN create one when joining; a person who already has a PIN enters that same PIN to link Google. Existing PIN-only employees can still complete initial setup on a paired register; forgotten-PIN recovery requires a linked account with a confirmed email. New employees are added through one invitation flow: name and role, share the link, then the employee signs in with Google and chooses their PIN. Linking Google preserves the existing PIN and employee ID.

Forgotten-PIN recovery uses an email confirmation link sent to the account's confirmed address. The link lasts 15 minutes, works once and lets the person choose a new PIN without Google reauthentication or a manual recovery code. It grants no login/operator session and closes prior operators for that person/business. A normal PIN change still requires the current PIN. Resend, migration 0007, the account function and frontend are deployed; real inbox delivery remains a manual check. See [email recovery](docs/pin-email-recovery.md).

Employee management uses one list, one Administrar action per employee and a focused form with Volver a empleados. Empleados and Dispositivos de caja are separate destinations directly under Más. New employees always receive a Google invitation and choose their own PIN; the owner sees no access-method checkbox or provisional PIN. Existing PIN-only access remains supported. Each employee's detail shows whether an invitation is pending, accepted, cancelled, replaced, expired or unavailable, with recorded dates rather than a generic “revocado o utilizado” message. Owners can confirm Eliminar empleado and explicitly restore the same person from Empleados eliminados. Deletion closes access and sessions; restoration preserves identity and PIN without reviving old sessions or invitation codes.

The earlier PIN policy/recovery changes were published on 1 October 2026 by Agente de Larios with new migrations `20261001000500_employee_pin_policy.sql` and `20261001000600_owner_pin_recovery.sql`; previously applied migrations remain unchanged. Final validation passed **57/57 real local integration**, **16/16 Deno** and **160/160 desktop/phone-width browser cases**, build/typechecks and the real local browser, compatibility and production-authentication smokes. Compatibility preserved existing people, PIN hashes, lockout counters and invitation codes, with canonical statement history **44/48/27/23/29/21**. Public route/asset checks passed **27/27** and anonymous API probes **20/20**. See [DEPLOYMENT.md](DEPLOYMENT.md) for release artifacts and limits.

The preceding employee lifecycle correction was published on 1 October 2026 by Agente de Larios, including migration `20261001000400_employee_lifecycle.sql`. Its validation passed 126/126 browser cases, 36/36 real integration tests and 13/13 Deno tests; public routes/assets passed 27/27. Successful cloud employee mutations, fresh business creation and physical-phone installation remain manual checks.

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
- Employee setup, owner recovery and normal PIN change have separate permissions. Setup and recovery codes contain 256 random bits; the database retains hashes, with no raw code in operation records or audit logs. Exact lost-response retries cannot overwrite a later PIN or revive a consumed/replaced authorization.
- Lock and logout hide the private view immediately and notify other open tabs while revocation completes. New entry stays disabled until that request settles. Reloads and expired operator sessions return to PIN entry. Server PIN lockouts include a countdown and disable immediate retries.
- Logout clears this device even when the network fails and explains when remote revocation could not be confirmed. Network failure never creates a local operator session.
- A logout cancels any pending OAuth callback, removes this app's PKCE verifier keys and revokes a late returned Supabase session. Late authentication events cannot restore the private view after logout.
- An already-revoked Auth session confirms repeated logout. A logged-out tab stays closed while a fresh Google login in another tab survives; delayed cleanup preserves newer sessions and PKCE verifiers.
- The PWA caches the application shell and local font. Authentication/account responses are fetched without caching. Business mutations require an online backend; this slice does not implement offline POS sales.

## Design source

Alpha v3 reference: black/white, local IBM Plex Sans, the same functions on phone and tablet, 420px authentication forms, concise Spanish controls and five bottom navigation destinations. See the local design system and reference read. This implementation includes business/access setup and the home shell. Catalog, sales, payments, inventory and invoicing operations are still pending.

## Current hosted release: access UI correction

Agente de Larios, 1 October 2026. Cambiar PIN now shares the same width and spacing as the other Más actions. Business settings, PIN and session actions are grouped consistently. Recuperación de mi PIN explains its independent recovery code. Employee creation labels Google as optional personal access and explains that a paired register needs only the employee's PIN. The existing backend and security policy remain unchanged.

Cloudflare production `e88f5deb-077f-419b-af15-1f366dd398d9` publishes the 20-file build with `index-Blvjyc9v.js`. Validation passed 162/162 browser cases, typecheck/build and 27/27 exact public hashes. The desktop/phone layout regression first reproduced the reported failure. Existing installed windows can retain an old worker; close and reopen the PWA to load the updated interface. See DEPLOYMENT.md and tests/README.md for scope and the local integration timeout reruns.

## PIN policy and recovery backend release

Agente de Larios, 1 October 2026. Supabase has all six migrations and the current account function deployed. Cloud/local comparison matched all 46 SQL functions; 18 private tables and nine public RPCs passed RLS/grant inspection. Cloudflare production `4332457e-e8b5-4ad2-8bcd-85a847714eb8` publishes the 20-file build with `index-DyQATu0Q.js`; public hashes passed 27/27 and anonymous API probes 20/20. These probes did not change production staff, PINs or recovery codes.

The waiting PWA worker was activated through visible browser developer tools; ordinary reload loaded the current bundle. The existing Google identity loaded its business and the missing-code recovery screen correctly blocked a Google-only reset. A fresh real Google account selection/callback/status flow completed and showed create/join for an account without linked businesses; no business was created. No human PIN or recovery code was entered or generated. Successful authenticated cloud employee/PIN/recovery/device mutations and physical-phone installation remain unverified. Other installed windows may retain old workers because there is no update banner.

## Historical hosted release: employee lifecycle

Agente de Larios · 1 October 2026 · employee lifecycle correction published.

Supabase project **POS México** (`sdisalomdxgejyhpxtri`) has migration `20261001000400_employee_lifecycle.sql` and the updated `account` function deployed. The previously applied 0001–0003 migrations were preserved; the canonical ledger now records **44/48/27/23 statements**. Ten changed SQL bodies match the final checked source, and private-table RLS, private helper restrictions and all nine public RPC browser/service grants passed inspection. The downloaded 26,669-byte Edge source matches the standalone artifact exactly (SHA-256 `28e973733f8c783a530061b29bd96deb51f5bc6d03715ea4a8627e77e57397df`).

Cloudflare production deployment `6cb52946-9921-4b92-b552-a3f282b225d2` publishes the 20 generated frontend files, including `index-BSzhioHG.js` and `TeamPanel-C7wE4MFL.js`. Public route/asset checks passed **27/27** with exact build hashes. Eight anonymous API probes passed with exact-origin CORS and no-store responses, including valid delete/restore payloads reaching `AUTH_REQUIRED`; these probes performed no employee mutations. Real Google selection, callback and account loading reached the existing business PIN screen. The waiting PWA worker was activated with the browser's visible developer tools; an ordinary reload then loaded the new `index-BSzhioHG.js` with the existing Google session. Installed windows can still retain an older worker because no update banner is implemented.

Final validation passed **126/126 desktop/phone-width browser cases**, **36/36 real local Auth/Edge/Postgres integration tests without skips**, **13/13 Deno validation/authentication tests**, frontend/backend typechecks, build and independent review. The real local browser smoke verified focused employee administration, actual invitation outcomes, removal and restoration, personal/register session invalidation and device revocation, then cleaned its synthetic fixtures. A separate real local 0003→0004 migration smoke preserved legacy invitation truth, expiry and existing codes. Fresh cloud business creation, successful authenticated cloud employee/invitation/device mutations and installation on a physical phone were not exercised in this correction. No human PIN was automated or recorded.

## Historical unified employee release

The following records the preceding 0003 release on 1 October 2026; its bundle and counts are historical.

Supabase project **POS México** (`sdisalomdxgejyhpxtri`) has migration `20261001000300_unified_employee_access.sql` and the updated `account` function deployed. All nine modified SQL function bodies match the final source by SHA-256. Private-table RLS and restricted browser/service RPC grants remain intact. The canonical cloud ledger contains foundation/business-team/unified-employee migrations with **44/48/27 statements**. Only 0003 was applied; the transaction required the exact existing 0001/0002 history.

Six anonymous API probes passed with exact public-origin CORS and `no-store`: the prior status/device rejection checks plus new Google creation, targeted invitation and name-free acceptance payloads reaching `AUTH_REQUIRED`. These checks prove the current parser/error contracts without creating staff or granting access. The downloaded deployed function matched the standalone source byte for byte (SHA-256 `c581150f7a1a50bd9fd1afa93b4ee38f021308a98ed00d5dc1c17e74891c7882`).

Cloudflare production deployment `219368ec-e1e8-4b3c-95e0-314b6adb8158` publishes the 20 generated frontend files. The hosted gate passed **27/27** with hashes identical to local `dist`. The active browser loaded `index-BSeLiTyb.js` after reopening the PWA to activate its worker. Real Google account selection/callback/account loading passed, and the authenticated owner opened Venta, Más and the team panel. The published panel showed one Agregar empleado action, targeted Vincular Google and a Google-enabled form without provisional PIN fields. No production staff or invitations were created for this inspection.

Local validation passed **98/98 browser cases**, **27/27 real Auth/Edge/Postgres integration tests**, **12/12 Deno tests**, build/typecheck and independent review. The real browser smoke verified atomic pending Google creation, same-ID linking, no duplicate employee or repeated name, old credential/operator invalidation, personal/register entry and device revocation. A real local 0002→0003 migration smoke confirmed old accepted/pending invitation codes, target backfill and legacy retries. Fresh cloud business/profile creation, successful staff/invitation/device mutations and physical-phone installation remain unverified. PIN entry itself was not automated or recorded in this inspection.

The function's legacy JWT gateway verification remains disabled because personal commands verify the authenticated user, Google OAuth method and live Supabase Auth session in the handler/backend, while device commands validate their restricted credential in Postgres. Tenant and PIN checks remain active. The Site URL, sole app callback and API origin use the hosted HTTPS app; the local password-auth test flag is forbidden in cloud.

The Google Cloud project remains `pos-mexico-510316`. Its existing Web application OAuth client uses the hosted JavaScript origin and the Supabase provider callback. The preceding auth/home releases verified real Google login/logout/relogin/reload, an existing PIN and lock, and navigation into Venta/Productos/Más; those historical results do not replace verification of this new release. Fresh cloud business creation and physical-phone installation have not yet been established.

The earlier frontend preview at `http://127.0.0.1:5173` targeted the development cloud through `.env.local`. `.env.cloud` holds that cloud public configuration and `.env.local-stack` preserves the separate local-stack configuration; both are ignored by Git. Production builds use checked-in public `.env.production` settings. Keep server and Google secrets out of browser settings and shared Drive documents.

Google's documented basic-identity exception allows testing with only name/email/profile identity scopes without a manually managed test-user list: [Google OAuth production readiness](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview). Do not add Gmail/Drive or other sensitive scopes for this access flow.

Before a future cloud schema push, authenticate the CLI privately, link the correct project and confirm that its history still agrees with checked-in migrations:

```sh
npx supabase link --project-ref sdisalomdxgejyhpxtri
npx supabase migration list --linked
```

The dashboard reconciliation above is complete. CLI linking and these inspection commands have not been executed in this deployment session; do not repeat history repair or reapply the foundation blindly. Enter any prompted database password privately.
