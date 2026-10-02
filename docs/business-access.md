# Business selection and employee access

Agente de Larios · 2 October 2026. Implements Larios's current request: the same Google account can own businesses and work in other businesses, switch between them, return to employee access after logout, and scan an invitation in the application. Local evidence below does not establish production publication.

`status` lists only the current identity's active memberships with an active matching employee record. Migration `20261002001700_business_membership_roles.sql` adds each membership's server role. It preserves the existing recovery flags, live Auth check, private schema and service-role RPC grants. No membership, PIN or operator is created by selection. The existing account Edge dispatcher forwards this response without runtime changes.

The selector groups **Mis negocios** and **Como empleado**, with Dueño/Encargado/Cajero/Cocina labels. An older backend without roles stays usable through **Negocios disponibles**; the client does not infer owner rights from recovery flags. Creating a business and opening another invitation remain available. Switching closes the current operator and refreshes memberships. Each business requires its own PIN and retains its server permissions and employee browser binding.

Employee-entry intent survives the OAuth redirect. It never automatically selects an owned business. The last successfully entered business ID is remembered separately per Google user, solely to choose the next PIN screen. The client checks that ID against fresh memberships before using it; a removed access or a different account cannot inherit it. Neither PIN nor operator token is saved. Invitation and explicit creation entry take precedence over remembered selection.

Personal and shared-register operators use the same HomeScreen, catalog and responsive navigation; owner administration remains owner-only, cashiers see their own sales and kitchen keeps its restricted destinations. The shared-register operational shell now uses the same main-content and accessibility layout as the personal shell.

**Escanear QR** appears in employee entry and joining. The user starts the camera explicitly, with a rear-camera preference. QR decoding uses the already-installed jsQR package, promoted to a runtime dependency and loaded only when scanning. Frames are processed locally. Only complete invitation links from this app's origin are accepted. Denial, unavailable camera and decoding errors retain link entry; cancellation, navigation, tab hiding and successful decoding stop the stream. Sources: [getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [jsQR](https://github.com/cozmo/jsQR).

Products come from the selected tenant for both owner and employee. The existing catalog refresh runs every 15 seconds while visible, on focus and reconnection; **Actualizar productos** also provides an immediate refresh in Venta and Productos. This is online refresh, not offline synchronization or an instantaneous push guarantee.

## Verification and release

Regressions cover dual memberships after real local Auth logout/relogin, server tenant/role enforcement and removal of inactive access; the same signed-in employee reads products created or modified by the owner without seeing products from their own business. Browser cases cover OAuth return, logout/relogin, grouped switching, automatic/manual catalog refresh, QR decoding from a synthetic camera stream and denied permissions. The development smoke uses two real local browser contexts, creates an employee's own business before accepting the other business's invitation, and verifies a product created after employee login. Fixtures are cleaned.

Apply and verify migration 0017 before merging the dependent frontend, using [DEPLOYMENT](../DEPLOYMENT.md). Number 0016 belongs to the separate products-deletion PR; coordinate migration order with that pending release. This change does not depend on product deletion and does not deploy its migration or Edge artifact. No cloud memberships or human accounts were modified. Real Google consent, physical camera scanning and installed-PWA behavior require separate verification.

Context read: Drive **02 — Estado del negocio y contexto**, **04 — Decisiones y pendientes**, latest **05 — Registro de sesiones**, and the 1 October business/employees session. Their dated statements retain their historical scope; Larios's current instruction controls this behavior. Drive was read without edits.
