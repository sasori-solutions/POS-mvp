# Permanent employee unlinking

Agente de Larios · 2 October 2026, America/Chicago.

Larios explicitly requested permanent removal of an employee from the business and a new PIN on reinvitation. This supersedes PR #5's restoration behavior, which retained the old PIN and employee identity and caused the reported “you already have a PIN” prompt.

Deleting an employee now removes the employee row and business membership, their PIN credentials, operator sessions, invitation links, PIN setup/recovery links, personal device binding and related notifications. Audit events retain their event counts with employee identity/session references removed. The global Auth account, its Google sign-in, other business memberships and shared register devices are preserved. Global signed-request replay records remain to prevent old signed requests from being reused.

A new invitation creates a new employee ID. The same Google account can accept it, choose and confirm a new PIN and enroll the current browser. Old PINs, operator sessions and consumed invitations cannot regain access. Existing active PIN-only employees who add Google access still verify their current PIN; they have not been deleted.

The deleted-employee list and Restore action are removed. Both Edge validation and SQL reject restoration, including old clients. Opaque operation hashes prevent retries of old creation commands from recreating a deleted employee and allow deletion retries to complete safely. They contain no employee name, email, Google user ID, PIN or device credential. Owner mutations serialize within a business to keep deletion and retries consistent.

## Migration and release

Migration `20261002001100_employee_permanent_unlink.sql` applies the same removal policy to previously soft-deleted non-owner employees, drops obsolete restoration/merge state and disallows future soft deletion. Active or disabled employees are preserved. Historical migrations remain unchanged.

1. Run the integration suite and both real browser smokes against an isolated loopback Supabase stack.
2. Run `tests/integration/employee-unlink-migration-smoke.mjs`, then `scripts/prepare-employee-unlink-release.mjs` to generate source-bound release artifacts. The primary SQL applies products/sales 0010 and unlink 0011 only over the exact tested 0001–0009 ledger. An alternative applies only 0011 when the exact products 0010 ledger is already present. Both transactions reject any mismatch.
3. Run `scripts/employee-unlink-purge-preflight.sql` for anonymous aggregate counts before applying the destructive cleanup. No individual employee information is returned.
4. After PR checks and merge, apply the guarded migration, verify schema/function bodies/permissions/ledger, deploy the updated account Edge function, then publish merged main using the serialized Pages workflow.
5. Verify public assets match the build and anonymous Edge probes reject restoration. Authenticated human production flows and physical camera scanning are not implied by these checks.

Before integrating the concurrently merged products/sales change, local validation passed: **214/214 desktop/mobile browser cases**, **69/69 real Auth/Edge/Postgres integration cases without skips**, **23/23 Deno cases**, production build and Edge typecheck. Four focused integration cases passed again after additional stale-invitation/operation and direct-SQL restore assertions. Both real browser smokes passed, including QR decoding, same Google account/new PIN/new employee on same and different browsers, rejection of old PINs/sessions, device replacement notification approval, and Mailpit PIN recovery. Synthetic fixtures were cleaned.

The earlier standalone unlink compatibility smoke passed with **62 functions, 22 private tables and canonical statement counts 44/48/27/23/29/21/16/26/11/23**. It verified purge of old Google/PIN-only/merged records, preservation of other-business access, exact source function/schema/grant matching, rejection of a mismatched ledger, and safe Auth/business deletion cascades. Disposable databases were removed. Production publication remains a separate step.

Products/sales was merged to main during this release. Unlinking follows it as migration 0011. Merged-source checks passed **238/238 browser, 9/9 domain, 14/14 embedded SQL, 23/23 Deno**, lint, typecheck and production build. Both guarded upgrade paths (9→11 and 10→11) passed against CLI application: **67 functions, 26 private tables, canonical statement counts 44/48/27/23/29/21/16/26/11/27/27**, with no schema, permission or ledger failures. Sales totals/items and historical operator names remain transaction snapshots; employee/operation actor references become null. A reinvited employee cannot replay the prior actor's sales operation.
