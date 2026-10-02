# Working together with Codex

Both developers use the same path to production:

**Own worktree → branch → PR → the other developer reviews → merge → CI deploys → verify.**

## Start one task in one checkout

Read [AGENTS.md](AGENTS.md), [README.md](README.md) and the affected module's documentation. Fetch `origin/main`, inspect the working tree and start a short `feat/`, `fix/` or `chore/` branch in a separate worktree or clone. In Codex, use its managed worktree feature; from a terminal, an example is:

```sh
git fetch origin
git worktree add ../POS-mvp-fix-example -b fix/example origin/main
cd ../POS-mvp-fix-example
npm ci
```

Choose a distinct path and branch for your task. Keep each agent in its assigned checkout. Never stage, discard or commit another person's changes. Agree on the scope in the task/PR; if work overlaps, coordinate the shared files and migration order before integrating it.

## Make the change and open a PR

Keep the PR focused and review the diff before committing. Use Node 24 and the checked-in lockfile. Run:

```sh
npm run test:smoke
npm run build
```

These are **Basic checks**, the automatic gate on PRs and `main`. Run additional focused tests when the change affects UI, permissions, SQL, money or other behavior. The full suites remain available through **Full checks (manual)**; [tests/README.md](tests/README.md) documents their requirements. State actual results and omissions.

Push your branch and open a PR targeting `main`. Explain the result, tests, and any migration/function dependency. Request review from the other human developer. Agent review can help prepare the change, but it does not replace that review. Do not push directly or force push to `main`.

## Review, prepare the backend and merge

The reviewer checks the behavior and diff, the latest **Basic checks** result, and any backend dependency. If `main` advanced, update the branch, resolve conflicts and rerun the relevant checks before merging.

For frontend-only changes, a reviewed green PR is ready for the authorized merge. For backend changes, follow [DEPLOYMENT.md](DEPLOYMENT.md): apply and verify compatible migrations and Edge Functions **before** merging the dependent frontend. Check the actual cloud migration history; local migration files and old release notes do not prove it is ready. CI does not deploy Supabase. Changes that cannot coexist with the current client need a staged compatibility plan.

Respect the current human request's scope for merging and publishing. This workflow and historical release records do not grant an agent permission for unrelated external actions. PR review remains the team's operating agreement even if the repository's GitHub plan cannot enforce it.

## Let CI publish and verify the result

A PR branch runs checks. Merging to `main` starts **CI**, which runs **Basic checks**, saves its `dist`, and passes that exact artifact to **Deploy Cloudflare Pages**. Production uploads are serialized and skip superseded commits. There is no separate routine dashboard upload and no second build in the automatic deployment path.

Check the workflow for the merged commit through its Cloudflare upload and public-asset verification, not just the green PR check. The deployment must correspond to the intended `main` commit. Report the PR, commit, CI run and deployment result before calling the change live. Follow up with the affected real authentication/backend/device checks when required; byte verification only establishes the published frontend assets.

If deployment fails, follow the recovery procedure in DEPLOYMENT. Do not race CI with a dashboard or local CLI upload. An already-open PWA may still use its previous worker; distinguish a cached client from a failed deployment.

Keep evidence in the PR or the affected module's dated release record. Keep operating rules in AGENTS, this workflow here, and production configuration/recovery in DEPLOYMENT; do not prepend another session diary to the root documents.
