# Lean POS MVP implementation

Human instruction, 2 October 2026. This document records the approved scope and the progressive delivery boundaries; a checked-in implementation is not evidence of a hosted release.

## Approved behavior

The existing personal/shared-register signed transport, owner identity, React/TypeScript/Vite/Tailwind and private Supabase schema remain. New operational commands use explicit employee grants; owners retain their protected distinction. Manual product/variant availability replaces live quantity tracking while retaining dormant historical metadata.

Orders hold accepted price, selection and included IVA snapshots. Immutable preparation batches have New, Preparing, Ready and Delivered states, independent of payment. Bills settle through server-persisted checkout attempts before money is collected. Accepted mutations are atomic, identified by UUID and payload fingerprint, and editable entities require a revision. Uncertain collection is resolved deliberately without collecting twice.

One shared drawer uses Open → Closing → Closed. Closing freezes collection, refunds and movements before counting. Unpaid orders survive shift changes. Expected cash is opening plus cash sales/entries minus refunds/withdrawals. Counts and financial records are immutable; payment totals do not claim bank settlement.

One whole-order fixed/percentage discount requires a reason and exact cent/IVA allocation. Cancellation keeps preparation history. Waiving prepared/delivered unpaid balances requires the owner. Full sale reversals require confirmation that the external refund occurred and affect the current cash shift, never a previous closed count.

Tables have one open account, support a move to an unoccupied table, and close explicitly after all balances are settled/canceled. Final checkout precedes item splitting. Integer quantities receive exact allocations; the first paid bill freezes the account. One method/payment/sale per bill. Additional purchases start a new account after table closure.

Server reports use the business-local calendar day and include gross, discounts, reversals, net sales, known IVA, payment/operator/product totals, cash differences and separate waivers. Unpaid balances are excluded. Legacy financial records remain reportable without invented snapshots.

## Reviewable increments

1. Employee checkbox grants; manual availability (separate changes).
2. Shared shifts, checkout recovery, movements, closing and initial daily totals.
3. Persistent orders and preparation queue.
4. Discounts, cancellation/waiver and full reversal.
5. Table accounts and whole-account settlement.
6. Item splitting at final checkout.
7. Complete reports and connected verification.

Backend changes must be published compatibly before dependent frontends. Mandatory-shift activation is a deliberate cutover after pending legacy registrations and active PWAs are reconciled. Reviewed PRs and the procedure in DEPLOYMENT.md govern production publication.

## Sources and evidence

The current human request governs the scope. Drive documents 02, 04 and the latest 05 entries were re-read on 2 October 2026; their earlier feature deferrals do not override this request. No Drive content was edited. README, supabase/README, tests/README, docs/products-sales, design-system and reference-read were consulted against origin/main `76ea338`.

Implementation and verification evidence is recorded with each PR. The compatible operational backend is reviewed before its dependent PWA modules. Local fixtures and browser viewports do not establish hosted Google access, physical PWA installation or terminal hardware compatibility. Production publication follows DEPLOYMENT.md after the other developer reviews the changes.
