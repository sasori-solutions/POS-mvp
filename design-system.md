# Alpha account and home implementation

Palette: ink #111111, background #FFFFFF, surface #F6F6F6, border #E4E4E4, secondary #626262. Error text remains high-contrast; no decorative accent.
Type: local IBM Plex Sans 400/500/600. Body 16px/1.5, captions 14px/1.4, titles 30px/1.15 with restrained negative tracking.
Spacing: 8px base, 16px input gaps, 24px groups, 40px major separation. Controls 52px minimum; content width 420px auth, 1040px business shell.
Layout: phone uses a full white screen and bottom-positioned primary action. Tablet keeps the same flow in a centered, quiet panel, with a small wordmark and ample margin. Forms remain left-aligned; PIN uses six visual positions backed by an accessible password input and optional numeric keypad.
Behavior: Google redirect with PKCE, business fields validate before PIN creation, PIN is confirmed before server submission, account data is only rendered after backend unlock. Lock and full logout are separate named controls. No fake identity or local PIN storage.

Home: business header, Venta catalog area and fixed five-item navigation with safe-area spacing. Phone and tablet use the same destinations and controls. The empty catalog and upcoming modules state their availability without sample operational data. Más exposes the saved business details, lock and logout. All navigation items support keyboard focus; the selected destination uses aria-current.
Ready: successful creation remains a separate confirmation at /business/ready. “Ir al inicio” opens home using the current operator session. Reloading either private route still requires the PIN.

Business/team extension: new Google accounts choose Crear mi negocio or Unirme a un negocio; existing memberships go directly to selection/PIN. Initial business setup includes branch/register names, payment methods and optional public address/contact. Owner editing, staff, invitations and paired devices use the same monochrome forms and server loading/error states. A shared register starts at /employee, uses a one-use pairing code and then employee name/PIN; changing operator hides private content immediately. Kitchen navigation contains Comandas/Más; cashier excludes Ventas; owner controls appear only for personal owner sessions. These are local implementation flows pending deployment of their backend migration.
