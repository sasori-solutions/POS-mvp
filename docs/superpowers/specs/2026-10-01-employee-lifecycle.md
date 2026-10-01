# Employee administration correction

Agente de Larios, 1 October 2026. Follow-up to the published unified employee flow.

The human reports that employee administration remains redundant, invitation labels do not describe what happened, and employees cannot be deleted. Keep one employee identity and one place to administer it.

## Interaction

The employee list excludes the owner, who is already represented by the account header. Each employee has one **Administrar** action. Adding an employee or opening their details replaces the list; **Volver a empleados** returns to it. Devices have a separate tab. There is no second global invitation list.

Creation has name, role and an optional **Invitar a usar Google** checkbox. PIN-only staff have a confirmed PIN. Google invitations create pending staff without a provisional PIN, and the owner shares the generated link manually. Editing existing details does not ask for a PIN unless **Crear PIN** or **Cambiar PIN** is selected.

Each detail page shows Google/PIN access and its invitation facts. The backend returns pending, accepted, revoked, expired or unavailable, with real timestamps and a recorded cancellation reason when known. Acceptance remains a historical fact after later employee deletion. Legacy cancellations have no invented reason. A generated code can be copied only while it is known in the current interface; renewing creates a new code and invalidates the previous pending invitation.

**Eliminar empleado** asks for confirmation, removes the person from the main list and closes access. It is a soft deletion preserving identity and history. A collapsed **Empleados eliminados** section provides explicit owner restoration. Restoring returns the existing PIN/Google access; previous sessions and invitation codes remain revoked. Explain this effect before restoration.

## Server guarantees

New migration 0004 adds deletion and invitation outcome metadata without altering applied migrations. Owner-only delete/restore operations require an operation UUID. A stale retry must return its authorized result without reversing a later restore/delete. Deleted employees cannot be edited, invited or revived by creation/acceptance retries.

Deletion disables employee and membership, revokes personal/register operators, and invalidates every remaining invitation code, including previously accepted codes. Restoration preserves identity, credential lockout counters and audit history. It cannot revive operators or codes. Invitation creation/revocation and employee deletion use consistent locking with acceptance.

## Verification and scope

Reproduce the reported interface/status/lifecycle failures before implementation. Cover owner/employee/cross-tenant permissions, exact outcomes, expiry/cancellation, PIN lockout, old sessions, operation replay and concurrent acceptance/deletion against real loopback Auth/Edge/Postgres. Run the browser suite at phone and desktop widths, and a real local browser smoke without API response mocks. Check migration 0003 to 0004 compatibility and private grants.

Publish only the checked migration, function and generated frontend to the existing projects under the continuing deployment instruction. Inspect hosted routes/assets and the current owner interface. Do not create invitations or delete actual staff to test production. Keep cloud mutation verification distinct from synthetic local evidence.
