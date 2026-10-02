# PIN recovery by email

Agente de Larios · 1 October 2026. Deployed to production; real inbox delivery remains a manual check.

The user chose email confirmation instead of recovery codes and Google reverification. Resend verified the user-supplied `larioscow.dev`. The human saved the key in Supabase; its existing permissions were reduced to Sending access for this domain. Configured sender: `POS México <acceso@larioscow.dev>`. No real PIN, key or recovery link belongs in repository/Drive evidence.

## Production evidence

Cloudflare production **9cbb112c-668d-4274-b411-3e592720e695** publishes 20 files including `index-CEC8y_T0.js`; **28/28** anonymous route/asset hashes match the release build. ZIP SHA-256: `826cdaaab3e3a36c75543d05ff79d90be60e25c44af125d2f3caacea0cbfc812`.

Migration 0007 passed the exact six-migration history guard. All **52 SQL function bodies** match the checked local sources; **19 private tables** and private/public RPC permissions have zero verification failures. Canonical statement counts: **44/48/27/23/29/21/16**. The downloaded deployed `account` source is byte-identical to the 36,017-byte standalone artifact, SHA-256 `f5f464fddf5b1f285840194d9ba2f94d4b01de6bd892a7119ef1a3c581709ef8`. All **26 anonymous cloud API probes** passed, covering rejected legacy resets, invalid identities/devices/links, caller-selected recipients/redirects, CORS and no-store responses.

The new deployment renders the incomplete-link state. An existing canonical-host browser still loaded the previous service worker bundle; close all app windows and reopen to adopt the update. No real recovery email was sent and no human PIN was changed during verification. Domain/secrets configuration and anonymous probes do not establish successful provider acceptance or inbox delivery.

## User flow

Olvidé mi PIN → Enviar enlace al correo → email button Elegir nuevo PIN → enter/confirm six digits → PIN actualizado. Personal accounts and linked people on paired registers use this flow. The backend reads the confirmed account address; callers cannot choose a recipient or redirect. Confirmation works in another browser without Google. It grants no Auth or business operator session. The person returns to their original account/register and enters the new PIN.

Business creation no longer generates a code or requires a save-code acknowledgement; Más no longer offers code enrollment. Existing PIN-only people have no mailbox: the request explains that the owner must link their account in Empleados. Legacy initial PIN setup remains compatible. Cambiar mi PIN still requires the current PIN.

## Server checks

Migration 0007 adds private, RLS-protected recovery storage. Requests require a live verified Google identity, or an unexpired paired-device credential for the selected person in that business, active matching membership/employee and a confirmed email. Five requests per account per hour and a 60-second minimum interval are enforced in SQL. Each request replaces prior links for that person/business. The random 256-bit link is stored only as SHA-256 and expires in 15 minutes. The service marks delivery accepted only after Resend succeeds; failed delivery/configuration is never reported as sent.

Confirmation checks the link, delivery, expiry, active matching membership, unchanged confirmed account email, account ban/deletion and prior salted PIN hash. Viewing does not consume it. Employee deactivation, removal, restoration, role changes and Google linking invalidate prior links. Confirmation uses the employee → credential → recovery lock order shared with PIN changes/unlock, writes bcrypt, clears PIN cooldown, consumes the link and revokes all personal/shared operator sessions for that person/business.

An operation-ID retry only reports the already committed result while its result hash remains current. It never overwrites a later PIN, clears a later lockout or issues access. Legacy reset_pin/create_recovery_code are rejected by HTTP validation and the public SQL dispatcher. Existing historical hashes/records remain intact. Browser roles cannot execute any account RPC directly. Ordinary Auth login still requires Google; the email capability only confirms a PIN reset.

The link uses a URL fragment, omitted from HTTP access logs/Referer. The app removes it before rendering and holds it only in memory. Reloading requires reopening the original email. No raw link/PIN is logged, persisted in browser storage or returned by request_pin_email.

## Activation

1. Verify the user-owned domain using only Resend's generated DKIM and sending DNS records. Keep click/open tracking disabled. Preserve existing web/MX/DMARC records.
2. Create a Resend key with Sending access restricted to the verified domain. Save it only in Supabase Edge secrets as RESEND_API_KEY. Set PIN_RECOVERY_FROM and APP_ORIGIN=https://pos-mexico-mvp.pages.dev. No Auth SMTP/provider change is needed: account sends scoped PIN emails through Resend's API.
3. Run `node tests/integration/email-recovery-migration-smoke.mjs`, then `node scripts/prepare-pin-email-release.mjs`. Review the standalone Edge and history-guarded SQL artifacts in /tmp. Apply only migration 0007, deploy account with verify_jwt=false, then the matching Cloudflare build. Preserve Google and exact-origin settings.
4. Compare SQL/grants and downloaded Edge source with artifacts; check public route/asset hashes. Test real email only with a user-authorized recipient. Provider acceptance alone does not prove inbox delivery.

## Verification

Mailpit captures local mail without real recipients. See .env.functions.example; loopback APP_ORIGIN and the existing local-only password test flag are required. Never enable test variables in cloud.

- 54/54 real Auth/Edge/Postgres integration cases (`npx vitest run --maxWorkers=1 --testTimeout=30000`).
- 170/170 desktop/mobile browser cases; 16/16 email cases repeated after clearing validation text on edits.
- 18/18 Deno parser/auth/email cases, backend/standalone typechecks, production build and diff check.
- Real browser/Auth/Edge/Postgres/Mailpit smoke: email opens in a signed-out browser, PIN updates, original account unlocks; invitation/staff/register compatibility passes. Synthetic fixtures cleaned.
- Real 0006→0007 compatibility: identities, PIN hashes/counters, invitations and previous operators preserved; retired reset rejected, private grants verified. Canonical counts 44/48/27/23/29/21/16.

Obsolete code-flow expectations were replaced by email/permission checks. One run during Edge reload had three HTTP 502s; the stable final suite passed in full. Real inbox delivery, authenticated cloud PIN reset and physical-phone testing remain unverified.

Primary references: [Resend API](https://resend.com/docs/api-reference/emails/send-email), [verified domains](https://resend.com/docs/dashboard/domains/introduction), [Mailpit API](https://mailpit.axllent.org/docs/api-v1/).
