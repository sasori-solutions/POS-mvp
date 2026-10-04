# Point release preparation — 3 October 2026

Source: Codex task worktree `point-integration-review`, integrating PR #21 and the current task's existing UI/financial work. Human instruction: publish live and resolve remaining PRs. PR #19 was closed because its sale design was already integrated through PR #20; its changes remain in the application.

## Backend evidence

- Target verified: Supabase `sdisalomdxgejyhpxtri` (POS México).
- Applied the eleven pending canonical migrations `20261003203000` through `20261004005500` together, preserving the financial trigger/privilege dependency. Their exact source hashes were checked against the migration history. The MCP wrapper history entry was replaced by the canonical entries; no application records were deleted.
- Applied `20261004042218_point_official_sandbox.sql` separately, preserving its canonical version and source in the history. Applied locally without a reset as well.
- Before and after: 2 businesses, 20 sales, sale total 70,041,450 cents, 5 orders, 9 checkout attempts. All nine ledger/adjustment consistency counters returned zero.
- Published `account` version 15 and `point`, `point-webhook`, `point-worker` version 1. Downloaded sources matched the four generated standalone files exactly. Deno checked those files successfully.
- Anonymous malformed account/facade calls returned validation errors with no-store. The worker rejected unauthenticated requests. The webhook returned configuration unavailable because no webhook secret is configured; this is not evidence of an operational webhook.

## Checks

- Current source: 154 unit tests and 261 component tests passed (including sandbox activation and payment-method readiness cases).
- Focused sandbox/validation/SQL: 38 tests passed. Provider adapter regression: 23 passed.
- Build, TypeScript, production artifact guard, lint and diff checks passed.
- No visual browser review or physical terminal test performed. Remote CI and public asset verification must still be checked for the final merged commit.

## Follow-up verification — 4 October 2026

The browser suites were updated to use the current owner dashboard, automatic personal PIN entry and real operational accounts/checkout reservations in the local SQL fixture. The 302 distinct browser cases were covered in passing focused runs; the final sale/Point batch passed 68/68 without retries or skips. No financial assertions or CI gates were removed. CI uses two browser workers for the independent fixtures.

The double-submit case exposed a UI race: a second synchronous tap could clear the payment progress state while the first submission was pending. A generation-scoped synchronous guard now preserves that state; the durable mutation and database protections already prevented a duplicate sale. Terminal onboarding also checks the saved payment methods before declaring readiness and directs the owner to enable Mercado Pago explicitly.

The first remote run passed Basic checks and Edge validation, but exposed obsolete UI selectors and an order-sensitive permission-array assertion. Those checks were corrected; the final branch and merged-commit CI results remain the release authority.

## Configuration pending

The user confirmed that the Mercado Pago application/credentials are not configured. Official simulation is implemented but has not been exercised against Mercado Pago. Charges remain disabled and no business has been activated. The existing local HTTP simulator is a separate development tool.

Activation requires the private server configuration and scheduler in [the Point runbook](point-pilot-runbook.md), then verification of the real test identity, virtual terminal and provider events. No claim of live card acceptance or physical hardware compatibility is made by this release. Final frontend publication evidence belongs to the exact GitHub CI run and Cloudflare deployment, following [DEPLOYMENT.md](../DEPLOYMENT.md).
