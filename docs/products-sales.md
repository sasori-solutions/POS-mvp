# Products and online sales

Implementation on `feat/products-sales`, 1 October 2026. This branch has not been deployed to Supabase or Cloudflare.

## Existing architecture and extension

React/TypeScript/Vite PWA, local IBM Plex Sans and Lucide icons, the existing Home navigation and account client. The frontend has no new runtime dependency. `pos-contracts.ts` defines product/cart/sale commands; `pos.ts` handles exact money and the existing personal/device transport; `pending-sale.ts` retains uncertain registration commands. Screen state remains in React. Catalog refreshes on focus, reconnection, every minute and operator request.

The `account` Edge Function retains Google/live-session verification, exact JSON keys, the 8 KiB limit, allowed-origin CORS and `no-store`. Personal `pos` commands extend `account_secure`, preserving signed browser proofs, one-use nonces and employee device binding. `device_pos` uses the existing restricted register context and preserves linked-employee denials. No browser table access is added. SQL is authoritative for permissions, catalog versions, totals and atomic persistence.

| Role | Catalog | Product mutations | Register sale | History/detail |
| --- | --- | --- | --- | --- |
| Owner / manager | All products | Create, edit, activate/deactivate | Yes | Business sales |
| Cashier | Active products | No | Yes | Own sales |
| Kitchen | No | No | No | No |

Paired-register requests derive business and employee from the restricted device/operator credentials. They cannot provide an arbitrary tenant. Employee activation, membership and personal/device session validity are checked on every command, including a retry.

## Model and financial consistency

Migration `20261002001000_products_sales.sql` adds private `products`, `sales`, `sale_items` and `pos_operations`, with RLS and composite tenant foreign keys. `pos_execute` and `pos_device` are executable only by `service_role`; private helpers are revoked from browser roles.

Products have category text, active state and optimistic version. Deactivation is reversible; finalized sales keep their name/category/price/operator/timezone snapshots. There is no physical product deletion or sale editing API. Product images are deferred because the existing storage subsystem is not enabled; product names remain the primary touch target.

All amounts use integer MXN cents. Product prices allow 0–99,999,999 cents, quantities 1–999, at most 40 distinct lines, and sale totals up to 9,999,999,999 cents. Client decimal parsing avoids binary floating-point rounding. HTTP validation rejects fractional/invalid money and quantity, duplicate/empty lines, extra fields and incorrect totals. SQL verifies all prices, active states, versions and totals again.

One UUID identifies each mutation within the business. An advisory transaction lock, actor and canonical payload fingerprint prevent conflicting reuse. A retry of an accepted command returns its original result before checking changed prices, availability or payment settings. Stable-order product locks protect the accepted snapshots against concurrent edits. Sale, items and operation result commit atomically; an induced persistence error rolls all of them back.

Methods are `cash`, `card_external` and `transfer`, restricted to the business settings. Card copy is “Cobra en tu terminal y registra el pago.” Transfer requires the operator to verify receipt. There is no PSP integration or PAN/CVV collection. Prices are final product prices; subtotal equals total because discounts, tax breakdowns, tips and mixed payments are outside this request.

## Recovery and UX

Before a sale request, the browser saves only operation ID, method, product IDs, quantities, versions and integer amounts, scoped to business/employee. Credentials and card data are excluded. Storage failure stops submission. A synchronous guard blocks repeated taps; Web Locks serialize reservation/cleanup across tabs. A second tab presents the same pending registration rather than overwriting it. Cleanup only removes the matching operation, preserving a newer pending sale.

A lost response, reload, lock/logout or operator expiry retains the command. After the same employee unlocks, explicit retry uses the identical UUID and instructs them not to collect payment again. A definite catalog/payment rejection restores the draft for review. Malformed storage is retained for recovery, not silently erased. Ordinary unsubmitted carts survive navigation but do not persist reload. Sale registration requires online connectivity and a browser supporting Web Locks; this is not an offline outbox.

The operational shell follows the human request: ivory, evergreen primary actions, muted orange warnings, 14px corners, large touch controls, outline icons and restrained dividers. Existing authentication stays intact. The latest Drive v3 phone/tablet renders supply category/search, touch catalog, account and five-destination structure. Phone uses a dedicated account view and bottom “Ver cuenta”; tablet/desktop place the account alongside the catalog. Native dialogs provide focus containment, Escape behavior and focus restoration.

## Validation and rollout

Run `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`, `npm run test:e2e`. Backend: `deno check supabase/functions/account/index.ts` and `deno test supabase/functions/account/*.deno.ts`.

Domain tests cover exact money, bounds, timezone, HTTP validation and durable storage. PGlite SQL tests execute every checked-in migration and verify private grants/RLS, tenant/role restrictions, real device and personal session rejection, snapshots/replay, version conflicts, rollback and keyset pagination. Browser tests intercept synthetic OAuth/HTTP; financial calls execute those same PostgreSQL RPCs. They cover product lifecycle, all methods, quantities/removal, lost response/reload/PIN, rapid taps, multiple tabs, storage quota, rejected recovered drafts, stale/inactive products and 320/390/768/1024/1440px layouts. Synthetic screenshots are in ignored `artifacts/qa/`.

PGlite is a single embedded database session: these checks do not establish multi-connection lock concurrency or the live Supabase Auth/Edge gateway. The 75 inherited integration cases plus seven product/sale cases require Docker and skip when unavailable. CI now starts an isolated loopback Supabase/Auth/Edge/Mailpit stack and runs them serially with complete credentials. Financial cases exercise simultaneous identical/conflicting submissions, deactivation versus cashier acceptance, tenant/role/browser-proof checks, paired registers, receipts and rollback/retry. Physical phone/PWA installation and cloud Google/device/product/sale workflows remain deployment checks.

For a separately authorized rollout: inspect the linked project's migration history and concurrent employee work, apply only pending migrations, deploy the updated `account` function, then upload verified `dist` to the existing Cloudflare Direct Upload project. A GitHub branch push does not publish the application. Re-run the hosted gate and authenticated manual flows after deployment. Preserve existing credentials, RLS and origin restrictions. Orders, inventory, invoicing, terminal integration, refunds and offline operation remain subsequent modules.
