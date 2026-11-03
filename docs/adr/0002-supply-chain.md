# ADR 0002: the supply chain in alpha

| | |
|---|---|
| **Status** | accepted |
| **Date** | 2026-10-21 |
| **Deciders** | the implementer of alpha-p0-060, a coding agent, as the task's open questions allowed |

## Context

Security §7 fixes the alpha supply chain: a frozen lockfile, a minimum release age for new versions, no install scripts from dependencies, secret scanning in every worktree and in the pipeline, dependency and license checks, a `SECURITY.md`. The task left the release age to the team, with seven days as the common choice, and asked for the settings in `.npmrc`. pnpm 12 reads its settings from `pnpm-workspace.yaml` only: a `.npmrc` line such as `minimum-release-age` is ignored by pnpm and warned about by npm, which was checked before this was written.

## Decision

- **Seven days.** `minimumReleaseAge: 10080` in `pnpm-workspace.yaml` (pnpm counts minutes). Most registry attacks are caught within days of publishing; a week keeps the update bot's merge requests weekly rather than daily. `minimumReleaseAgeExclude` stays empty; a version needed sooner is an entry there, with the reason in the merge request.
- **Build scripts refused until reviewed.** `strictDepBuilds: true` with `allowBuilds: {}`: a dependency with an install script fails the install, which is the review; the reviewer adds `<name>: true` under `allowBuilds` to let it run, or `<name>: false` to install it without the script (a local `file:` dependency is keyed `<name>@file:<path>`). The list is empty today: nothing in the tree needs a build step. The root's own `prepare` script is the one that runs, to install the hook.
- **The lockfile is frozen in CI by pnpm's own rule**, `CI=true`, which the GitLab job sets, plus `--frozen-lockfile` on the job's install line, not by a global `frozenLockfile: true`, which would also fail the `pnpm install` that registers a new workspace package after `pnpm module:new`.
- **gitleaks from its image.** No binary to download per platform, no package with an install script: `zricethezav/gitleaks:v8.30.1`, pinned by digest in `tools/ci/secrets-scan.ts`, runs with the checkout mounted at its own path, for the hook and for `secrets:scan`. The hook therefore needs Docker running, as the development stack does anyway.
- **Licenses.** The allow-list is coding §10's as SPDX identifiers: MIT, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0, PostgreSQL. ISC, which three transitive dependencies of the changeset tool carry, is excepted per package in `tools/ci/license-exceptions.json` with the reason; adding ISC to the rule is the owner's call.

## Consequences

- `pnpm add` refuses a version younger than a week and a dependency with an install script; both messages say what to do. The update bot's merge requests carry the label `dependency-update`.
- A commit with a secret is rejected on the laptop before it exists; a secret found in the history is removed and rotated, never allowlisted.
- The full pipeline needs the network for the audit and Docker for the scan.
