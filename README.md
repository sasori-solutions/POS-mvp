# POS México

A React, TypeScript and Vite PWA for a single-location café or restaurant. Cloudflare Pages serves the frontend; Supabase provides Google authentication, the `account` Edge Function and private PostgreSQL data.

Public app: [pos-mexico-mvp.pages.dev](https://pos-mexico-mvp.pages.dev).

## Work together and ship

**Own worktree → branch → PR → other developer reviews → merge to `main` → automatic Cloudflare deployment.** Opening a PR runs checks; merging it publishes after **Basic checks** succeeds. The production job reuses that run's checked build. Backend migrations and Edge Functions require a compatible release before merging a dependent frontend.

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for the shared workflow and [DEPLOYMENT.md](DEPLOYMENT.md) for configuration, deployment verification and recovery. Codex reads [AGENTS.md](AGENTS.md). A merged commit or this README is not evidence of a successful production release; check the deployment for that commit.

## What the current code supports

- Google sign-in, business creation/settings, a personal six-digit PIN, lock/logout and recovery through a single-use email link. Recovery changes the PIN without granting a login session.
- Owner-managed employee invitations and roles. Employees use `/employee`, sign in with Google and choose their own PIN. Access binds to their browser; the owner approves a replacement. Deleting an employee permanently removes that business's employee access. Reinvitation creates a new employee identity and PIN.
- Shared-register pairing at `/register` for existing PIN-only employees. Google-linked employees use their personal linked browser.
- Product creation, editing and activation; online sale registration in MXN for cash, external card terminals and confirmed transfers; sales history with role-based access. Finalized sales preserve their snapshots and uncertain registrations can be retried without registering twice.

Orders/comandas, inventory, shifts and cash close, refunds, invoicing, automatic payment processing and offline sales remain outside the implemented slice. Branch/register names configure the initial location; they do not provide multiple-location operation. These statements describe checked-in behavior, not completion of real Google, email, payment or physical-device production tests.

## Local development

Use Node 24, matching CI, and install the lockfile dependencies in your own worktree:

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Before starting the app, set `.env.local` to your development backend's public Supabase URL and publishable key. Vite runs at `http://127.0.0.1:5173`. For isolated Auth/Edge/Postgres tests, use the local Supabase setup in [supabase/README.md](supabase/README.md). Missing configuration shows a setup message; there is no demo-login bypass.

The checked-in `.env.production` contains public browser configuration for the hosted backend. Never put service-role keys, Google secrets, provider keys or database passwords in a `VITE_*` variable, repository file or build output.

Run the small automatic gate locally:

```sh
npm run test:smoke
npm run build
```

Run focused browser, SQL, Deno or local integration tests for the behavior you change; [tests/README.md](tests/README.md) explains the fixtures and service requirements. **Full checks (manual)** is available in GitHub Actions. Mocked OAuth tests and skipped integration tests do not establish working production access.

## Documentation map

| Document | Purpose |
| --- | --- |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Workflow for both developers and their Codex agents |
| [AGENTS.md](AGENTS.md) | Current operating rules and technical invariants |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Canonical production procedure and verification |
| [supabase/README.md](supabase/README.md) | Backend trust boundary and local setup |
| [tests/README.md](tests/README.md) | Test commands, scope and dated evidence |
| [Products and sales](docs/products-sales.md) | Product, sale and retry contracts |
| [Employee device access](docs/employee-device-access.md) | Invitation, browser binding and notifications |
| [Permanent employee unlinking](docs/employee-permanent-unlink.md) | Deletion policy and migration 0011 |
| [PIN email recovery](docs/pin-email-recovery.md) | Recovery contract and delivery checks |
| [Design system](design-system.md) / [reference read](reference-read.md) | Module styles and design context |
| [Archived PRD and rules](docs/history/2026-10-02-agents-before-workflow-cleanup.md) / [previous README](docs/history/2026-10-02-readme-before-workflow-cleanup.md) | Historical context preserved with dates and sources |

Module documents contain dated implementation and release notes. Their old branch names, test counts and release instructions retain their original scope; use DEPLOYMENT for the current release process and verify the deployed revision separately.
