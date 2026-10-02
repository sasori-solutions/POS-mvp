# Reinviting a deleted employee

Agente de Larios · 2 October 2026, America/Chicago.

> Historical record of PR #5. Its restoration behavior was explicitly rejected by Larios and superseded by [permanent employee unlinking](employee-permanent-unlink.md). Do not use restoration as a current workaround.

## Report and cause

After an employee accepted an invitation, the owner deleted that employee and created another invitation. Signing in with the same employee Google account then displayed “No tienes acceso a este negocio.” Deletion intentionally retained an inactive membership so the owner could restore the employee, but invitation lookup and acceptance rejected every existing membership, including deleted employees. The QR itself encoded the correct invitation link.

The issue was reproduced against isolated local Auth, Edge and Postgres: a fresh account could inspect and accept the invitation, while a deleted account received `BUSINESS_ACCESS_DENIED`. Production read-only aggregate checks also confirmed retained inactive memberships for deleted employees. No human identities, PINs or account records were changed during diagnosis.

## Intended correction

A fresh owner invitation issued after deletion can reactivate the original deleted employee record. It keeps the employee ID, history, existing PIN and linked browser, and applies the name and role assigned in the new invitation. Existing PIN lockouts apply before restoration; successful verification clears failed attempts as normal. The unused new invitation placeholder is retired and cannot be restored as a second person. Existing active accounts and accounts that were merely deactivated remain protected from automatic merging.

The returning employee enters the existing PIN. A different browser still requires owner approval. If acceptance consumes the invitation while requiring device approval, the app clears the used invitation and moves to the regular PIN screen without an operator session, so reloading does not reopen an already-used invitation. A background status refresh is optional. An account conflict stays on the invitation screen with a clear explanation and an option to switch Google accounts.

If the returning employee forgot the PIN, the owner must first use **Empleados eliminados → Restaurar**. The employee can then use the existing email recovery flow; a new invitation does not reset the PIN.

## Verification and release

Migration `20261002000900_employee_reinvitation.sql` is additive; applied migrations 0001–0008 remain unchanged. The Edge runtime has no source changes and needs no redeployment. The optional `returningEmployee` response field is backward compatible.

Local checks completed: **216/216 desktop/mobile browser cases**, production build/typecheck, **75/75 real local integration cases (10 new regressions), without skips**, and the isolated **0008→0009 compatibility smoke**. The latter preserves existing people, PINs and devices, rejects a mismatched prior migration ledger without changes, and verifies **62 functions, 22 private tables, grants, constraints and nine canonical ledger entries** with zero failures. New integration cases include PIN lockout, preserved device approval, concurrent reinvitations, both owner-restoration race orders, stale pre-deletion links and Auth deletion cleanup. The real browser smoke also passed without API mocks: owner UI deletion and fresh QR generation/decoding, same-browser return, a second deletion and reinvitation from a different browser, pending-approval reload, owner inbox approval and successful PIN entry all retain the original employee ID. Synthetic accounts and businesses were removed.

Release order:

1. Run `node tests/integration/employee-rejoin-migration-smoke.mjs` on the isolated loopback stack. It creates and removes its own disposable databases, without resetting a shared stack.
2. Run `node scripts/prepare-employee-rejoin-release.mjs`. It refuses source hashes or canonical ledgers that differ from the tested evidence and emits guarded migration SQL plus a read-only verification query in `/tmp/pos-employee-rejoin-*`.
3. After PR checks and integration, apply the guarded SQL to the configured Supabase project, then confirm all verification arrays are empty. The canonical statement counts are **44/48/27/23/29/21/16/26/11**.
4. Publish the merged `main` through **Deploy Cloudflare Pages**, then run the public asset gate. Until publication, restore the original employee under **Empleados eliminados** as a workaround.

The browser link remains specific to a browser installation, and notifications remain in-app. Physical camera scanning and authenticated operations on human production accounts are separate checks.
