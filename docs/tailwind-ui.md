# Tailwind and unified interface — 2 October 2026

Author: Codex. Scope: the current human request to migrate all application styles to Tailwind, install design guidance/tools after the migration, then improve the visual identity and keep development available locally.

## Implementation

Tailwind CSS 4.3.3 runs through the official `@tailwindcss/vite` plugin. `src/styles.css` contains the theme, base accessibility defaults and shared component patterns using `@apply`. Responsive layout and states live as static utilities in the React components. The four previous module CSS files are removed, including their imports. `package-lock.json` records the two added development dependencies; no additional runtime UI library is required.

The latest human correction rejects the replacement visual identity and pins the original interface. The system retains local IBM Plex Sans, white backgrounds, near-black text, neutral gray secondary text and dividers, flat navigation and list rows, and the original Lucide icons, wordmark, favicon and installation assets. Square blue is reserved for product/checkout actions. Added outer panels and the four-cell mark have been removed. Controls retain 48px minimum touch targets. Phone uses a two-column product grid, account step and bottom navigation; tablet/desktop retain a separate bounded account and the same authorized destinations. Breakpoints all use rem units so Tailwind's ordering cannot restore three phone columns.

The change covers identity/business access, PIN and recovery, employee/register entry, notifications, settings/team/device management, product library/editor/selection, checkout and sales history. Prices remain integer-cent calculations and use the existing shared formatters. User-defined tile colors remain data-driven inline backgrounds. Real product photos and empty states remain honest; no invented operational records are added.

Keyboard focus, reduced motion, safe areas and visible async errors are preserved. An accessible skip link reaches the main content. Inputs, placeholder contrast and selection/alert states share the theme; dialogs contain overscroll and the phone editor occupies the full viewport.

## Installed guidance and MCP

After the first Tailwind build and 25-unit-test pass, installed user-level skills from inspected public source repositories:

- [Impeccable](https://github.com/pbakaus/impeccable), version 4.5.0, `.agents/skills/impeccable`, installed at `~/.codex/skills/impeccable`. Applied its Operate, craft-floor and polish guidance. Its first context invocation hit a downloaded file's execute permission; used the repository's existing product/design documents directly. The execute bit is now corrected. No competing product record or standing workflow preference was invented.
- [Vercel Web Design Guidelines](https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines), version 1.0.0, installed at `~/.codex/skills/web-design-guidelines`. Read the current upstream rules and used them for focus, labels, numeric typography, image dimensions, contrast and responsive review.

The skills are discoverable on the next turn. The [official shadcn MCP](https://ui.shadcn.com/docs/mcp) is registered in the local Codex configuration as `shadcn`, using `npx -y shadcn@4.21.1 mcp`. A direct MCP client handshake succeeded; registry item metadata, the field-demo example and audit checklist returned successfully. Codex loads this new server on restart. Reference tooling lives outside the repository and is not an application dependency. Existing Context7 and Playwright configuration was reused, rather than duplicated. No third-party account or paid service was created.

## Sources and verification

Product scope: current human messages, README, current design-system/reference-read, module/local-development documentation, and a fresh read of Drive 02, 04 and the latest 05 entries on 2 October. No Drive content was edited. Square remains the human-selected operational reference. Current Square POS and shadcn field pages were viewed in the browser; the latest correction uses the repository’s original presentation as the visual authority.

Verification evidence is recorded in this branch; ignored `artifacts/qa/` holds synthetic captures and command logs. The corrected interface passed all 258 browser cases, plus 25 smoke tests, the production build and lint. After the last header alignment adjustment, all four targeted phone/tablet and breakpoint checks passed again; the build and lint also passed again. The migration’s earlier full browser run passed 256 cases. The final browser suite adds a responsive regression for two phone columns, control dimensions, header action grouping, selected-state contrast and horizontal overflow at 320/390/600/768/1024/1440px. The keyboard regression now verifies skip-link focus and continuation to Google. A prior run's two failures came from the old assumption that Google was the first Tab target.

This is local development work. Browser API/OAuth interception plus real embedded PostgreSQL RPCs in the existing test harness do not establish fresh Google consent, physical touch hardware or installation. Manual local review uses real loopback Auth/Edge/Postgres and the existing synthetic café. No cloud schema, main merge or production deployment is part of this request. The branch also carries the preceding, still-unmerged product/checkout expansion; its backend requirements remain in `products-sales.md`.
