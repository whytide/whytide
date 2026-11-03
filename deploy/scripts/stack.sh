#!/usr/bin/env bash
# The shared development stack: one Compose project per laptop, `whytide`, started from any worktree
# and never duplicated per task (docs/rules/delivery.md §2). The root scripts stack:up, stack:down and
# stack:status call this.
#   stack.sh up [--profile observability] [--profile tools]   start (profile dev always on), wait for health
#   stack.sh down [--wipe]                                     remove the containers; --wipe the volumes too
#   stack.sh status                                            every container of the project and its health
# Ports and passwords come from deploy/.env when it exists (git-ignored), else from the defaults in
# compose.yaml, which deploy/.env.example lists. COMPOSE_PROJECT_NAME overrides the project name; the
# stack test uses that to run a throwaway copy next to the real stack.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

usage() {
  echo "usage: stack.sh up [--profile <name>]... | down [--wipe] | status" >&2
  exit 2
}

command="${1:-}"
[ $# -gt 0 ] && shift
profiles=(dev)
wipe=false
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) [ $# -ge 2 ] || usage; profiles+=("$2"); shift 2 ;;
    --profile=*) profiles+=("${1#--profile=}"); shift ;;
    --wipe) wipe=true; shift ;;
    --) shift ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ "$wipe" = false ] || [ "$command" = down ] || { echo "--wipe applies to down only" >&2; usage; }
[ "${#profiles[@]}" -eq 1 ] || [ "$command" = up ] || { echo "--profile applies to up only" >&2; usage; }

compose=(docker compose -f deploy/compose.yaml)
case "$command" in
  up)
    for profile in "${profiles[@]}"; do compose+=(--profile "$profile"); done
    "${compose[@]}" up -d --wait --wait-timeout 90 --remove-orphans
    ;;
  down)
    args=(down --remove-orphans)
    [ "$wipe" = false ] || args+=(--volumes)
    "${compose[@]}" --profile '*' "${args[@]}"
    ;;
  status)
    "${compose[@]}" --profile '*' ps -a
    ;;
  *) usage ;;
esac
