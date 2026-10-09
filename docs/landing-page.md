# POS México landing page

The requested destination is `https://pos.larioscow.dev/`. Source is `landing/index.html`, `landing/style.css` and `landing/main.ts`; publication follows [DEPLOYMENT](../DEPLOYMENT.md). `/landing/` provides the same document for development and asset verification. The app continues at `https://pos-mexico-mvp.pages.dev/`.

## Content and design

The audience is café/restaurant owners in Mexico. The main action opens the existing app; section links and native FAQ disclosures work without application JavaScript. Content follows the current README and code, with Drive 02/04/05 consulted on 8 October 2026; those Drive documents still carry their September/October dates and do not prove commercial traction. No prices, customer claims, AI features or unverified hardware promises are introduced. Product and menu illustrations are explicitly synthetic.

Tokens: white `#ffffff`, ink `#17191d`, secondary text `#626872`, action blue `#0766e8`, soft blue `#e7f0ff`, separators `#e5e8ed`. Local IBM Plex Sans carries both display and body text. The layout pairs a left-aligned introduction with a large register illustration, then groups operational capabilities, a menu example, setup steps, FAQ and a final app link. Mobile stacks the hero and preserves readable type and touch targets. The register and preparation ticket carry the visual character; there are no animated statistics, testimonials or repeating card frames.

The page uses semantic landmarks, one h1, visible focus, a skip link and native keyboard-operable disclosures. Navigation is in-page and primary links use the hosted app. Reduced motion disables smooth scrolling. Canonical, description, locale and SoftwareApplication metadata are emitted in static HTML. It does not register the app's service worker or call Supabase.

## Focused verification

- Run `npm run test:smoke` and `npm run build` with Node 24.
- `tests/unit/landing-routing.test.ts` checks exact-host root routing, GET/HEAD, preserved application/callback/asset requests, mutation passthrough and app worker registration only outside the marketing hostname.
- Inspect built landing HTML for static content and absence of app worker registration/manifest; confirm app HTML still registers its worker.
- Review `/landing/` on the isolated `npm run dev` server at phone/tablet/desktop widths, including keyboard focus, FAQ, primary destinations and overflow.
- After CI publishes, compare both public hostnames against that exact artifact and inspect HTTPS/domain status. A local render, DNS record or successful PR does not establish publication.
