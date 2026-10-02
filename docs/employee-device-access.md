# Employee invitations, linked browser and owner notifications

Agente de Larios · 1 October 2026, America/Chicago.

## Result

The employee button now opens personal employee access at `/employee`. An employee can open the owner's invitation link, scan its QR with the device camera, or paste the complete invitation link. Google verifies identity, then the employee chooses or verifies their own PIN. The invitation is still expiring and single-use; its QR is generated locally and encodes exactly the same link. No external QR service receives the token.

Accepting the invitation binds this employee to this browser installation. Existing Google employees enroll on their next successful PIN entry. A different browser with the correct account and PIN receives no business access and creates a persistent owner notification. The owner can reject the request or explicitly replace the linked browser. Replacement revokes earlier personal and shared-register operator sessions; the newly authorized browser must still enter the PIN. Owner accounts retain their existing multi-device behavior.

Owners have a notification bell with unread count and an inbox under Más. Initial linking and blocked device-change attempts are stored in the business's private database. Read state and decisions survive reloads. The app refreshes notifications while open every 30 seconds and on return to the foreground; this release provides in-app notifications, not background push or email delivery.

Shared-register setup lives at `/register`. Existing `/employee#pair=…` links canonicalize to `/register` after consumption. Legacy PIN-only employees remain supported in owner-paired registers; Google-linked employees must use their personal linked browser. They are filtered from register rosters, and direct register unlock/context/PIN-setup requests cannot bypass the binding.

## Enforcement and limitations

The browser creates an ECDSA P-256 key pair and stores the non-exportable private key in IndexedDB. Authenticated requests sign the exact payload plus a UUID nonce and timestamp. Edge verifies the signature and freshness before normalization; the service-only SQL dispatcher consumes the nonce and supplies the verified public-key digest to access checks. The backend checks employee binding when issuing and validating operator sessions. Wrong PINs do not create device-change notifications. Notification details and decisions require an owner operator session in the matching business.

This binds a browser profile/app installation, not a hardware serial number. Clearing browser data, using a different browser, or a separate PWA storage context can require a new owner-approved link. Non-exportable Web Crypto keys prevent ordinary JavaScript key export; they do not provide hardware attestation or protect a fully compromised browser/OS. No user-agent/IP fingerprint is treated as identity. The platform behavior follows [MDN's CryptoKey extractability documentation](https://developer.mozilla.org/en-US/docs/Web/API/CryptoKey/extractable) and [Web Crypto signatures](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/sign).

Owner approval and PIN recovery are independent. Recovering a PIN does not authorize replacing a linked device. Existing invitation/PIN lockout, idempotency, tenant isolation and live Auth-session checks remain enforced. Personal signing keys persist through logout so that signing back into the same browser does not request another device.

## Release order

1. Inspect the linked migration history; do not reapply 0008 if it is already present. For its authorized rollout, apply `20261001000800_employee_device_notifications.sql` after exact migrations 0001–0007, then deploy and verify the updated `account` Edge function (including `device-proof.ts`) **before merging the dependent frontend PR**. Coordinate the cutover: old clients without device proofs fail closed and must reload.
2. After review and passing checks, merge to `main`. CI automatically publishes the checked frontend build and verifies public route/assets, including `/register`. **Deploy Cloudflare Pages** is the manual recovery path; do not upload in parallel. Follow [DEPLOYMENT.md](../DEPLOYMENT.md) for the canonical process.
3. Verify real Google access and physical camera scanning on an authorized pilot device. Record backend and frontend evidence separately; frontend deployment does not apply Supabase changes.

Do not roll back to an old Edge/frontend pair while presenting device enforcement as active. The additive database schema preserves existing employees, memberships, invitation history, PIN hashes and business data. A rollback needs a reviewed compatibility plan; old Google-linked clients fail closed after the security migration.

## Verification

Results and exact commands are recorded with the PR and session note. Browser tests include QR decoding, complete invitation links, device proof persistence/tamper resistance, notification read/approve/reject, and denied employee entry. Integration tests use synthetic identities on an isolated loopback Supabase stack; no human accounts, PINs or notifications are modified.

Final local checks passed: `npm run build`; `npm run test:e2e` (**202/202**, desktop and mobile); and `TEST_MAILPIT_URL=http://127.0.0.1:55324 npm run test -- --no-file-parallelism --maxWorkers=1 --testTimeout=30000` (**65/65**, with the isolated stack's `TEST_*` environment). The real browser-to-Edge-to-SQL device smoke also passed, including second-browser denial, owner approval, and revocation of the original browser. PIN recovery preserves the existing binding; concurrent unlock/approval and delete/restore cases pass. Physical QR camera scanning and hosted Google OAuth remain release checks.

The updated `node tests/integration/real-onboarding-smoke.mjs` also passed on that isolated stack: business creation, legacy PIN setup, same-person Google linking, shared-register denial for linked employees, delete/restore, invitation cancel/renew/accept, register revocation, owner PIN change, and real Mailpit recovery from a signed-out browser. Both real browser smokes cleaned their synthetic identities and businesses.

Backend verification completed locally:

- `deno check supabase/functions/account/index.ts` and the generated standalone Edge source both pass. The four Deno files run **22/22 tests**, including exact-wire signatures, payload/nonce/time tampering, expiry, future timestamps and malformed proofs.
- `TEST_SUPABASE_WORKDIR=/private/tmp/pos-employee-device-backend node tests/integration/employee-device-migration-smoke.mjs` passes the real **0007→0008** upgrade in a separate disposable database. It preserves employees, memberships, existing PIN hashes and counters, invitations, devices and operator rows; existing owner access remains valid, while legacy Google employee sessions require device enrollment. It also checks first enrollment, denial with a durable notification, owner replacement, legacy PIN-only register access and private table/RPC privileges.
- The previous migration ledger remains **44/48/27/23/29/21/16 statements**; migration 0008 contains **26 statements**. No existing migration was edited. The smoke writes the canonical ledger to `/tmp/pos-employee-device-canonical-ledger.json`.
- `node scripts/prepare-employee-device-release.mjs` generates `/tmp/pos-employee-device-account-cloud.ts` and `/tmp/pos-employee-device-migration-with-history.sql`. The SQL artifact verifies the exact seven prior migration entries before applying 0008 in a transaction. Artifact generation does not deploy. Run `deno check /tmp/pos-employee-device-account-cloud.ts` before using the source.

The final SQL review checked every personal operator issuance and context validation, missing-proof fail-closed behavior, tenant/owner checks, stale approval retries, notification persistence on denied entry, and exclusion of keys, tokens and PINs from the feed. Request creation is limited to five different device requests per employee in ten minutes; repeating the same pending key is deduplicated. The inbox prioritizes pending decisions, then unread entries, then recent read history, so marking entries read reveals older unread entries within the 100-item response limit. Read history is limited; this is not a full audit-history export.
