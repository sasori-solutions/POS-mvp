# Business creation and employee access implementation plan

> Agentic workers execute the authorized PRD extension with coordinated ownership and test-first changes.

**Goal:** Complete business creation and both invited Google employee access and employee PIN access on a paired shared register.

**Architecture:** Extend the typed account Edge Function and private Postgres schema with transactional business profile, staff, invitations and devices. Add focused management/device components while keeping App responsible for Google identity, routing and in-memory owner/member operator state.

**Tech stack:** Existing React/TypeScript/Vite, Supabase Auth/Postgres/Edge Functions, Vitest and Playwright.

**Spec:** ../specs/2026-10-01-business-employees.md

## Constraints and review focus

- Preserve six-digit ASCII PINs, five-attempt/15-minute lockout, tenant/Auth-session checks and no operator/PIN browser persistence.
- Invitation/pair secrets expire, are single use, hashed at rest, and cannot assign owner role.
- Response loss/retry must preserve operation identity; concurrent use must not duplicate acceptance or devices.
- Revoked device or inactive staff must fail every later context request and clear private UI.
- Old owner OAuth/lock/logout/cross-tab tests and direct business creation routes must remain covered.
- Spanish, monochrome IBM Plex, same authorized functions on desktop/mobile, touch controls at least 48px.

## Backend and contracts — employee_backend

Files: src/lib/contracts.ts, supabase/functions/account, new 20261001000200 migration, tests/integration, supabase/README.md.

- [x] Write and run real-backend tests for profile persistence/edit, invitation accept/replay/expiry/permissions, direct staff PIN, device pair/switch/revoke/tenant denial, fresh-session PIN reset.
- [x] Extend AccountRequest/AccountResponses and DeviceRequest with owner/member actions and independently validated device actions.
- [x] Implement transactional private schema/RPCs; preserve old create_business requests via profile defaults.
- [x] Apply only new migration to disposable local stack; run Vitest integration, Deno validation/typecheck.

Example denial boundary:

```ts
const result = await request(cashier, { action: 'team', businessId, operatorToken })
expect(result.status).toBe(403)
expect(result.body.error.code).toBe('PERMISSION_DENIED')
```

## Management and device UI — employee_ui

Files: new TeamPanel.tsx, BusinessSettings.tsx, DeviceLogin.tsx and account-management.css.

- [x] Render owner staff/invitation/pairing/device lists from authorized team response; server errors stay visible.
- [x] Confirm PINs, retain operation IDs on retry, revoke/deactivate from server responses, never simulate success.
- [x] Persist editable profile with update_business and notify root of new context.
- [x] DeviceLogin loads device_status after reload, selects active staff and verifies PIN online. On switch/lock/expiry, clear operator immediately and revoke before allowing next unlock. Handle cross-tab device lock and revoke.

Interfaces: accountRequest/request and deviceRequest/request return typed AccountResponses; owner management props business/operatorToken/onBack; DeviceLogin onExit; HomeScreen role-scoped navigation and employee identity.

## Browser behavior — onboarding_tests

Files: tests/e2e fixtures and account-flow.e2e.ts, new onboarding-team.e2e.ts.

- [x] New-account choice test written and confirmed failing for missing choice heading.
- [x] Adapt existing owner fixtures with nested profile; preserve all prior auth regression tests.
- [x] Test creation profile, invitation acceptance/rejection/retry, owner settings/team, staff restrictions, device pairing/PIN/switch/reload/revocation.
- [x] Run `npm run test:e2e` on desktop and mobile; failures name real observable behavior.

## App and integration — root

Files: src/App.tsx, src/lib/account.ts, HomeScreen.tsx, README/AGENTS/design docs.

- [x] Separate device request transport from Google account authorization; retain no-store/timeouts/error envelopes.
- [x] Implement entry choice, direct-create intent, pending invitation fragment transfer, accept confirmed PIN and route assigned memberships.
- [x] Extend creation form with first branch/register and profile, preserve operation retry and owner PIN guards.
- [x] Route settings/team, expose switch business for single membership, add fresh Google PIN recovery state.
- [x] Hide owner-only views from employee role and refresh context/permissions while private screen is open.
- [x] Integrate components, run full backend/browser/build gates and independent security review, repair identified defects.
- [x] Update dated PRD implementation status and source/readme; save signed completion evidence in Drive after verification.

Commands: `npm run test`, `npm run test:e2e`, `npm run build`, `deno test supabase/functions/account/validation.deno.ts`, `deno check supabase/functions/account/index.ts`. No integration skip counts as successful verification.

## Local implementation verification — 2026-10-01, Agente de Larios

88/88 browser cases, 19/19 real Auth/Edge/Postgres integration tests, 10/10 Deno checks, frontend build and backend typecheck passed. Independent security/lifecycle review findings were repaired with regression tests. Real loopback browser and production authentication gate smokes passed and removed synthetic fixtures. At this local implementation checkpoint, no cloud deployment or Git commit/push had been performed. The later authorized deployment is tracked below.

Signed closure saved and read back from [Drive](https://drive.google.com/file/d/16EzjU3BRHRib4z7P95E4XjMfX2yDoKly/view).

## Authorized deployment — 2026-10-01, Agente de Larios

The human subsequently instructed “despliegalo entonces”. This authorizes publishing the verified business/team extension to the existing Supabase and Cloudflare projects.

- [x] Prepare a checked standalone function and production frontend build using only public browser configuration.
- [x] Verify existing cloud foundation before applying the unchanged business/team migration transaction.
- [x] Inspect cloud profile/employee schema, existing-member backfill, RLS and RPC/browser grants.
- [x] Reconcile canonical CLI migration history: `account_foundation` (44 statements), `business_team` (48).
- [x] Deploy the updated `account` function; anonymous hosted probes pass 3/3 with expected error contracts, exact-origin CORS and no-store responses.
- [x] Upload all 20 generated frontend files to Cloudflare and submit Save and deploy.
- [x] Confirm Cloudflare production deployment `55bd6be0-0ba1-41ac-be5c-1b141859b594`; the hosted route/asset gate passed 27/27 with exact `dist` hashes.
- [x] Verify real Google account selection, callback exchange and account loading through the existing business PIN screen; anonymous `/employee` renders register pairing.
- [x] Inspect the live business creation form, including expanded optional address/contact and payment methods, without creating a production fixture.
- [x] Download the deployed account function and compare it byte for byte with the checked standalone source; SHA-256 `bff27bb98eb7b46163847390ba4a856cd2172e791b30dcf172a92ab20cf5c168` matches.
- [ ] Verify human PIN entry on the current release. Fresh cloud business/profile creation, complete staff/invitation/pairing workflows and physical-phone installation remain manual checks.
- [x] Save signed deployment closure and remaining limits in Drive after the release checks: [deployment closure](https://drive.google.com/file/d/1qHh3EL2hnqBP4659zgQ7fJMTWrSvchF3/view).

Release sources can be published after the verified hosted asset and real Google checks; Git history records that publication separately.
