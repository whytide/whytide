#!/usr/bin/env bash
# The restore of a backup into a fresh stack (docs/runbook.md "Restore"): this folder's Compose
# project has no volume yet, on a new server or after `docker compose down --volumes`, and .env holds
# the passwords and the master key of the deployment the backup was made from. Postgres starts alone;
# postgres-setup makes the roles; the three databases come back with pg_restore before Temporal sees
# them, MinIO's folder before MinIO starts; then the whole stack starts as `docker compose up -d`.
#   restore.sh <backup folder>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
dc up -d --wait
echo "restore: $dir into $project in $(($(date +%s) - started)) s"
