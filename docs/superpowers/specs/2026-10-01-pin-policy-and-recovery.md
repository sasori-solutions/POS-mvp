# Employee PIN ownership and owner recovery

Agente de Larios, 1 October 2026. Larios requested one consistent employee PIN flow and challenged Google-only forgotten-PIN recovery on a shared owner device. The agreed change is implemented through new migrations 0005/0006; previous migrations remain immutable. This document describes the current source. Hosted publication and completed release gates belong in `DEPLOYMENT.md` and `tests/README.md`.

## Employee PIN

The employee chooses the PIN. The owner assigns name/role and authorizes initial setup or reset without entering that person's PIN. New PIN-only employees receive a hashed, one-use 256-bit authorization lasting 15 minutes; the employee chooses and confirms a PIN on a paired register for that business. A Google-linked employee can use the authorization with their own live identity. Neither authorization path links Google or grants owner access.

A new Google invitee without a PIN chooses one when accepting the invitation. An existing employee enters their current PIN when linking Google. The same employee ID, salted PIN hash and failure history are preserved; a second PIN choice is unnecessary. Incorrect PIN entry counts toward the existing shared cooldown without consuming the invitation. Personal and register access then use that one credential.

Consumption replaces the credential and closes the employee's prior personal/register sessions atomically. Replacement authorization, expiry, deletion, deactivation and Google linking invalidate earlier setup codes. Lost-response retries require the exact original caller/operation and unchanged current credential; they never rewrite a later PIN or clear a subsequent lockout. Raw codes and PINs stay outside database audit/operation payloads and browser persistent storage.

## Owner PIN

Normal change and forgotten-PIN recovery are separate actions. A normal change requires the owner's own unlocked operator and current PIN; Google-linked employees may also change only their own PIN this way. Both session types close, a replacement operator is issued, and the owner's independent recovery code remains valid.

Forgotten-PIN recovery requires the same owner identity, original Google authentication/session within five minutes, and an independent 256-bit recovery code saved outside the shared browser. Google alone cannot generate a recovery code or reset a PIN. Another account or employee cannot recover the selected owner's business, including on that owner's device.

Enrollment/renewal requires the current owner PIN and a live owner operator. New business setup generates the code after confirmed PIN creation and asks the owner to save it. If generation fails, the already-created business remains intact and only code generation is retried. The app asks for storage on another device or paper, clears its own clipboard copy when acknowledged or locked, and keeps the raw code only in memory. Existing businesses are not silently enrolled; the owner must first unlock with their known PIN. Missing enrollment returns `RECOVERY_UNAVAILABLE`, with no Google-only legacy fallback. If the owner has neither PIN nor prepared code, this implementation supplies no automatic recovery bypass.

Recovery atomically consumes the code, sets the new bcrypt PIN, clears its lockout, closes prior personal/register operators, issues a new personal operator and returns a replacement recovery code. Five wrong recovery attempts commit a separate 15-minute cooldown, including concurrent attempts. Only hashes are stored. Exact lost-response retries may rotate an unseen replacement code while the operation remains the current credential/generation; a later PIN/code change makes the old operation conflict.

## Concurrency and identity

Employee rows serialize credential changes, PIN verification and session issuance. Recovery racing old-PIN personal/register unlock or original business-creation replay leaves no old-PIN operator usable. Expected failures return values so their counters commit. Browser identity/recovery intent is bound to the initiating owner and selected business; account changes, a replacement Auth session for the same account, and lock/logout cancel pending work and revoke operators returned late. JWT refresh within the same Auth session preserves the flow. The server remains authoritative for every permission and session.

## Compatibility and evidence

Local focused PIN-policy/team/unified integration passed 37/37 cases; lifecycle regression passed 9/9. Real 0004→0005/0006 migration compatibility preserves existing people, hashes, counters and pending invitation codes and leaves legacy owners unenrolled. Its six-entry canonical ledger is 44/48/27/23/29/21. These counts establish local backend behavior; they do not establish a hosted release, actual cloud recovery, Google consent, or physical-phone installation.
