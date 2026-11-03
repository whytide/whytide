#!/usr/bin/env bash
# The end-to-end test of the repository skeleton (alpha-p0-010), run by `pnpm test` at the root.
# It clones the committed tree into a temporary directory, so uncommitted work is not tested:
# installs with a frozen lockfile, builds, type-checks, checks the formatting, proves the ignore
# rules, creates a module from the template and builds it, proves `pnpm changeset` writes a file,
# removes what it created and checks that the tree is clean again.
set -euo pipefail

root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
clean() { [ -z "$(git status --porcelain)" ] || { git status --short; fail "$1"; }; }

step "clone the committed tree: node $(node --version), pnpm $(pnpm --version)"
git clone --quiet "$root" "$tmp/whytide"
cd "$tmp/whytide"

step "install, build, typecheck, format:check"
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm format:check
clean "the tree is not clean after a build: a build output or a generated file is tracked"

step "ignore rules"
touch .env.local core/apps/api/modules.generated.ts
git check-ignore -q .env.local || fail ".env.local is not ignored"
git check-ignore -q core/apps/api/modules.generated.ts || fail "*.generated.ts is not ignored"
rm .env.local core/apps/api/modules.generated.ts

step "module:new sample"
pnpm module:new sample
for path in README.md AGENTS.md index.ts package.json tsconfig.json \
  permissions.ts prices.ts events.ts settings.ts messages/en.json \
  domain schemas api workflows agents ui tests \
  docs/concepts.md docs/data.md docs/flows.md docs/runbook.md docs/security.md; do
  [ -e "core/modules/sample/$path" ] || fail "core/modules/sample/$path is missing"
done
grep -rq '__module__' core/modules/sample && fail "a placeholder survived in core/modules/sample"
grep -q '"name": "@whytide/sample"' core/modules/sample/package.json || fail "the package name was not set"
pnpm install --no-frozen-lockfile
pnpm -F sample build
pnpm -F sample typecheck
pnpm format:check

step "changeset"
before="$(ls .changeset/*.md | wc -l)"
pnpm changeset --empty
after="$(ls .changeset/*.md | wc -l)"
[ "$after" -gt "$before" ] || fail "pnpm changeset did not create a file under .changeset/"

step "remove the sample and the changeset; the tree is clean again"
rm -rf core/modules/sample
git clean -qf -- .changeset
pnpm install --no-frozen-lockfile
clean "the tree is not clean after removing the sample module"

printf '\nskeleton test: ok\n'
