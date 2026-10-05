# Employee permissions — 4 October 2026

The approved Lean POS plan replaces employee role presets with grouped action checkboxes. `owner` remains a protected identity with implicit access to every known operational permission and exclusive business/team administration. Existing employee role strings remain in memberships and invitation transport for identity compatibility; they do not authorize operations or navigation. New employees receive the internal `cashier` identity and the explicitly selected grants.

Migration `20261002001800_employee_permissions.sql` adds a private `employees.permissions` array. It migrates the effective implemented rights once:

| Existing identity | Preserved grants |
| --- | --- |
| Manager | `catalog.read`, `catalog.manage`, `catalog.availability`, `sales.create`, `sales.read_own`, `sales.read_all` |
| Cashier | `catalog.read`, `catalog.availability`, `sales.create`, `sales.read_own` |
| Kitchen | None of the previously implemented catalog/sale actions |
| Owner | All known permissions through the protected owner identity |

The migration does not grant the new order, kitchen, cash, discount, reversal, report or table actions to existing employees. Their owner must choose those grants. Existing PIN hashes, credentials, sessions, invitations, employee IDs and receipts are retained during the upgrade. New employee rows default to no permissions; a role value never restores a preset.

The known permission groups are catalog (`read`, `manage`, `availability`), sales (`create`, `read_own`, `read_all`, `discount`, `reverse`), orders (`read`, `manage`, `cancel`), kitchen (`read`, `operate`), cash (`read`, `open`, `move`, `close`), reports (`read`, `read_own`) and tables (`manage`). Their exact request keys use a period, for example `orders.manage`.

## Personal metrics

Migration `20261005012000_employee_metrics.sql` adds `reports.read_own` without granting it to existing employees. The owner selects **Consultar solo sus métricas** in Empleados. It permits `report_own_period` through either authorized personal or shared-register transport. The server resolves the current employee ID; requests cannot choose another employee. Historical names do not define identity. Refunds, including Point refunds, belong to the original receipt's seller. The result excludes other operators and business cash differences.

`reports.read` remains the explicit grant for business-wide reports. Granting only `reports.read_own` never permits `report_period`, Point merchant analytics, or all-sales history. When an employee has both report grants, the interface opens their personal metrics; the wider server grant still exists. Changes revoke the employee's existing operators as before. The owner must select grants deliberately; a role string does not add them.

Selecting an action includes its prerequisite: catalog editing/availability and sale creation require catalog reading; discounts require sale creation; reversals require all-sales reading; order editing/cancellation, kitchen operations and cash operations require their respective reading grants. Clearing a prerequisite clears dependent checkboxes. HTTP validation, SQL mutation validation and the employee table constraint reject unknown/duplicate keys and incomplete prerequisites. Valid arrays are canonicalized before retry fingerprinting.

`create_employee`, `update_employee` and legacy name-based `create_invitation` accept `permissions`. Creation includes the selected grants in the accepted operation fingerprint. A changed creation payload conflicts, while an exact retry returns the current employee without overwriting later permission edits. A targeted invitation for an existing employee cannot edit grants. Invitation details, acceptance and acceptance retries read the current employee; the invitation's historical role/grants cannot revive prior privileges. Existing wire requests without `permissions` preserve grants on updates and existing creation retries. A new legacy creation without grants creates a grantless employee; assigning access requires the updated owner interface.

Owner-only employee updates and permission changes revoke all personal operator sessions for that employee/business and all shared-register operators for the same employee. This also applies to a direct privileged change of the grant array. PIN hashes and device enrollment remain unchanged; the next legitimate unlock receives current grants. Client permission/session failures invalidate in-flight generations before clearing private views, so a late response cannot restore an older authorized view.

Business context and employee/team/invitation projections include current `permissions`. The frontend uses `hasPermission` and `businessWorkSections`; employees with no live array receive no operational access. SQL `has_permission(business_id, employee_id, permission)` verifies a known key, active employee, matching tenant and any linked live membership. POS entry points continue verifying Auth/operator/device access, and the command handler checks the required grant before reading or replaying a stored mutation. History returns only an employee's own sales unless `sales.read_all` is current. Accepted financial results remain immutable.

The personal POS entry point locks the employee before its operator row and reauthorizes after both locks. This matches employee edits, preventing the employee/operator lock inversion while retaining serialization with revocation. `tests/integration/employee-permissions-concurrency.mjs` passed against a uniquely named disposable database on the loopback stack: revocation-first denied the delayed sale, sale-first committed once before revocation, and accepted replay was denied. The script removed its database afterward and did not modify the stack’s primary database. This exercises real PostgreSQL concurrency without claiming real Google or Edge delivery.

Focused verification uses synthetic rows in embedded PostgreSQL (`tests/sql/employee-permissions.test.ts`) for migration preservation, tenant/owner boundaries, private grants, session revocation, denied replay after revocation, creation fingerprint conflicts and current invitation grants. Unit tests check HTTP payloads and navigation without role fallback; the checkbox component test checks accessible action labels and prerequisite changes. These tests do not establish live Google, hosted deployment, actual device replacement or concurrent Auth/Edge/Postgres behavior. The backend migration and compatible account function must be applied and verified before merging the dependent frontend; follow `DEPLOYMENT.md` for release verification.
