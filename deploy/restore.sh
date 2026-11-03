#!/usr/bin/env bash
# The restore of a backup into a fresh stack (docs/runbook.md "Restore"): this folder's Compose
# project has no volume yet, on a new server or after `docker compose down --volumes`, and .env holds
# the passwords and the master key of the deployment the backup was made from. Postgres starts alone;
# postgres-setup makes the roles; the three databases come back with pg_restore before Temporal sees
# them, MinIO's folder before MinIO starts. Then the api starts alone with what it depends on, which
# applies the migrations, and sending closes through linkedin's own command in it: a backup can hold
# sending open and lose the steps that went out after it, and the worker is what sends. Only then the
# rest of the stack starts, the worker, the web and Caddy, as `docker compose up -d`. A close that
# fails, or answers anything but that sending is closed, stops the restore before the worker starts.
# Sending stays closed until the runbook's steps reopen it.
#   restore.sh <backup folder>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# linkedin's control command in the api's image, from its working directory (the image has no pnpm),
# and the operator its control event names.
close_sending=(node ../../modules/linkedin/dist/cli/control.js sending close --operator restore)

fail() { printf 'restore: %s\n' "$*" >&2; exit 1; }
dc() { docker compose -f "$here/compose.yaml" "$@"; }

[ $# -eq 1 ] || { echo "usage: restore.sh <backup folder>" >&2; exit 2; }
dir="$1"
for file in app.dump temporal.dump temporal_visibility.dump minio.tar; do
  [ -s "$dir/$file" ] || fail "$dir/$file is missing or empty"
done
project="$(dc config | sed -n 's/^name: //p')"
[ -n "$project" ] || fail "no project name from compose.yaml"
volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
[ -z "$volumes" ] || fail "the project $project has volumes already; restore goes into a fresh stack: $(tr '\n' ' ' <<< "$volumes")"

started=$(date +%s)
dc up -d --wait postgres
dc run --rm --no-deps postgres-setup
for database in app temporal temporal_visibility; do
  dc exec -T postgres pg_restore -U postgres --dbname "$database" --exit-on-error --single-transaction \
    < "$dir/$database.dump"
done
dc run --rm --no-deps -T --entrypoint tar minio -C /home/minio -xf - < "$dir/minio.tar"

# The api alone, with Postgres, Redis, Temporal and MinIO: Temporal's schedules may start workflows
# now, but they wait in the task queue for the worker, which starts after the close.
dc up -d --wait api
stopped="the worker, the web and Caddy were not started (docs/runbook.md \"Restore\")"
closed="$(dc exec -T api "${close_sending[@]}")" || fail "sending did not close, linkedin's control command failed; $stopped"
case "$(grep -xE '(changed|unchanged): sending closed' <<< "$closed" || true)" in
  "changed: sending closed") echo "restore: sending closed" ;;
  "unchanged: sending closed") echo "restore: unchanged: sending closed" ;;
  *) printf '%s\n' "$closed" >&2; fail "sending may be open, linkedin's control command did not say it closed; $stopped" ;;
esac
dc up -d --wait
echo "restore: $dir into $project in $(($(date +%s) - started)) s"
