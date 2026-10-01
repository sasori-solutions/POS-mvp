# Alpha authentication implementation

Palette: ink #111111, background #FFFFFF, surface #F6F6F6, border #E4E4E4, secondary #626262. Error text remains high-contrast; no decorative accent.
Type: local IBM Plex Sans 400/500/600. Body 16px/1.5, captions 14px/1.4, titles 30px/1.15 with restrained negative tracking.
Spacing: 8px base, 16px input gaps, 24px groups, 40px major separation. Controls 52px minimum; content width 420px auth, 1040px business shell.
Layout: phone uses a full white screen and bottom-positioned primary action. Tablet keeps the same flow in a centered, quiet panel, with a small wordmark and ample margin. Forms remain left-aligned; PIN uses six visual positions backed by an accessible password input and optional numeric keypad.
Behavior: Google redirect with PKCE, business fields validate before PIN creation, PIN is confirmed before server submission, account data is only rendered after backend unlock. Lock and full logout are separate named controls. No fake identity or local PIN storage.
