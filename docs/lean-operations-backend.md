# Lean POS operational backend

Implementation evidence, 2 October 2026. The current human scope is recorded in [Lean POS MVP](lean-pos-mvp.md); this document describes the server contract and local verification. It does not establish a hosted release.

## Authentication and grants

Operational commands use the existing `pos` and `device_pos` transport. The Edge function retains its 8 KiB request limit, exact JSON validation, explicit-origin CORS and no-store responses. Personal calls preserve signed browser proof, Google/Auth session checks and the eight-hour operator session. Shared-register calls preserve device revocation, employee binding and the restricted operator credential. No new browser-visible database endpoint is introduced.

The service-only RPCs call the private `pos_command` wrapper. The wrapper checks the live employee, membership and current explicit grants before every accepted replay. Owner-only activation and waivers additionally require a personal operator entry point; a shared register cannot use an owner record to obtain those actions. Mutations acquire the business lock before reading the current order/table authorization scope. A UUID belongs to one actor and payload fingerprint; conflicts cannot reuse it. Accepted counter retries retain their accepted scope after a later table move, while a new request must qualify for the current table account.

| Action | Required access |
| --- | --- |
| Read own counter state and prepare/record its payment | `sales.create` |
| Create/edit counter account | `sales.create`, same original actor, no table |
| Read shared orders / collect their bills | `orders.read` / `orders.read` and `sales.create` |
| Create/edit/send shared orders | `orders.manage` |
| Cancel unpaid quantities | `orders.cancel`; remaining prepared quantities must be waived |
| Discount | `sales.discount` |
| Read/operate kitchen | `kitchen.read` / `kitchen.operate` |
| Read/open/move/close cash | Corresponding `cash.*` grant |
| Manage tables and close their settled accounts | `tables.manage` and its `orders.read` prerequisite |
| Reverse a full sale | `sales.reverse` |
| Report | `reports.read` |
| Activate operational checkout or confirm a waiver | Protected owner, personal operator |

The prerequisite grant closure is defined in migration 0018 and the shared contract. An operator without cash-read access receives a shift status badge with monetary fields and movements masked.

Migration 0022 adds the table-read prerequisite to both the shared contract and SQL. Existing standalone table grants receive `orders.read` through the existing permission-change trigger, which revokes their live personal and shared-device operators; they must unlock again. The revised table CHECK constraint is revalidated against every employee row.

## Cash and recorded collection

There is one shared active drawer per business. `open_shift` records the opening amount. Entries/withdrawals require a positive integer amount, reason and current shift revision. `begin_shift_close` rejects every unresolved prepared, started or uncertain payment/refund attempt; accepted closing blocks subsequent collection, refund preparation and movements. It returns no expected amount. `close_shift` accepts the blind count and atomically writes the immutable expected amount and difference. Expected cash is opening plus cash payments and entries minus cash refunds and withdrawals. `abort_shift_close` explicitly returns an uncounted closing shift to open.

An order moves from service to final checkout before item assignment. `prepare_checkout` accepts line UUIDs and integer quantities, creates a persisted attempt and reserves the account against further changes. `start_checkout` records that collection started before the operator collects externally. `mark_checkout_uncertain` records uncertainty. `resolve_checkout` requires a deliberate confirmation and reason; completing a prepared attempt before collection started is rejected. Aborting records that no payment was received and releases its reservation. Resolving an uncertain attempt records the original collection operator and the current resolver separately.

Payment recording is manual: cash receipt, external-terminal charge or confirmed transfer. There is no terminal integration, bank-settlement assertion or offline mutation. A failed response is recovered by looking up the same attempt or retrying the same operation UUID, never by creating another collection. Payment and receipt insertion, paid quantities and the accepted response commit in one transaction.

The first completed payment freezes account lines and allocations permanently. Further bills consume remaining quantities. Orders survive cash-shift changes. Reversing a sale appends a full correction linked to its immutable original receipt. Its persisted attempt uses the current open shift and the original payment method, and requires collection-start plus explicit refund confirmation before completion. It does not reopen a finalized order or edit a closed cash count.

## Orders, kitchen and tables

Newly accepted order lines validate current product/version, selected price and manual product/variant availability. Existing lines preserve their name, category, selection, price and IVA snapshots. Increasing a line checks current availability; settling accepted quantities never revalidates the catalog. No automatic stock count is enforced or decremented.

Each send creates an immutable batch containing only newly sent quantities. Batch states advance New → Preparing → Ready → Delivered independently of payments. Sent lines cannot be removed, reduced below sent quantity or silently change their kitchen note. Cancellation appends an immutable amount/quantity record and a cancellation notice for sent unpaid quantities; previous batches and receipts remain. It cancels only the remaining unprepared balance, including after another bill was paid. A prepared balance requires an owner waiver: preparing exposes the exact remaining amount, and confirming rejects any intervening account revision or unresolved collection. Paid revenue remains intact and waivers are reported separately.

The kitchen response holds at most 100 batches. Oldest undelivered work takes priority regardless of age; delivered batches from the last day use only remaining capacity. If more than 100 batches are pending, subsequent ones enter the response as older work is delivered. Recent completed history cannot displace older pending work; complete history remains stored on the server.

A table has at most one occupied account, including paid, waived or cancelled accounts. Moving requires an unoccupied active table. A settled/cancelled account stays assigned until explicit close or move; the next purchase creates a new account. Tenant-qualified foreign keys prevent cross-business order/product/table/shift/sale references. Private tables use RLS and deny browser grants. Whole-business deletion cascades operational attempts, including reversal attempts with no order reference.

## Exact allocation and reports

Money is integer MXN cents, each product price is at most 99,999,999 cents, account/attempt amounts are at most 9,999,999,999 cents, quantities are 1–999 and requests carry at most 40 lines. SQL numeric arithmetic computes whole-account fixed/percentage discounts. Largest-remainder distribution with stable line UUID ordering allocates every discount cent. Included IVA uses the accepted rate after discount. Quantity splits use cumulative exact discount allocation; IVA follows cumulative net cents so a zero-value bill cannot acquire positive tax. The last slice conserves every original cent.

Reports use the server's current business time zone and local calendar day. All recorded receipts, including legacy receipts, remain included. Reversals affect their own effective day; payment/operator/product totals show sales, reversals and net values. Product totals use original receipt snapshots, including on a day with only a reversal. Reported IVA uses known immutable tax cents and does not infer missing legacy classifications from today's catalog. Unpaid/cancelled balances are excluded from collected income; waivers and closed cash differences are separate.

## Compatibility and local evidence

Migration 0020 retains the 0018 grant checks and 0019 manual-availability implementation as `legacy_pos_command`. New databases and upgraded businesses continue to accept legacy sales until the owner explicitly activates operations. Already accepted legacy UUID retries still replay after activation; new legacy checkout requests then receive `LEGACY_CHECKOUT_DISABLED`. Activation requires pending legacy registrations and active old PWAs to be reconciled as part of the reviewed cutover. Backend publication and release order remain governed by [DEPLOYMENT](../DEPLOYMENT.md).

The focused embedded PostgreSQL suite applies actual migrations and covers compatibility/cutover, tenant/current-grant isolation, kitchen/cancellation/waiver, exact discount/IVA splits, lost responses and original actor/resolver, blind count and current shift gates, immutable corrections and business-day reports, explicit table closure, partial cancellations, accepted counter replay after moves, rollback if response persistence fails and complete tenant cleanup. On 2 October 2026 the combined SQL suite passed **46/46** (12 operational, four final-review cases, 25 legacy product/sale and five grant tests). The Edge source passed `deno check`.

The real integration suite passed **12/12 without skips** through migration 0022, using actual local Auth, signed Edge calls and separate PostgreSQL connections. It observed lock waiters for collection/closing/movement/refund races and exercised exact splits, accepted recovery after table moves, personal/register revocation, prepared waivers, queued cancellation and tenant cleanup. Synthetic Auth users and orphan attempts were absent after cleanup. Source/staged SQL and all six applied 0022 ledger statements match exactly. These loopback results do not establish hosted Google access, physical hardware or PWA installation.
