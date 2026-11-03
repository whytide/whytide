#!/usr/bin/env bash
# The backup of a deployment (docs/runbook.md "Backup"): the three databases of the postgres service,
# the product's `app` and Temporal's two, each with pg_dump in its custom format, and MinIO's data
# folder, its buckets with MinIO's own metadata, copied while MinIO stops for that moment, into
# <target>/<UTC time>/; then only the newest <n> backups stay in <target>, 7 by default. It drives
# this folder's compose.yaml with its .env, from any working directory, and needs Docker only.
# The master key is not in a backup: keep deploy/.env elsewhere (docs/runbook.md).
#   backup.sh <target> [--keep <n>]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() { echo "usage: backup.sh <target> [--keep <n>]" >&2; exit 2; }
fail() { printf 'backup: %s\n' "$*" >&2; exit 1; }
dc() { docker compose -f "$here/compose.yaml" "$@"; }

[ $# -ge 1 ] || usage
target="$1"
shift
keep=7
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) [ $# -ge 2 ] || usage; keep="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || fail "--keep takes a count of 1 or more, not $keep"

umask 077
dir="$target/$(date -u +%Y%m%dT%H%M%SZ)"
[ ! -e "$dir" ] || fail "$dir exists already"
mkdir -p "$dir"
started=$(date +%s)
for database in app temporal temporal_visibility; do
  dc exec -T postgres pg_dump -U postgres --format custom "$database" > "$dir/$database.dump"
done
# MinIO's folder is copied by a container of its image on its volume while the service is stopped,
# so no write is caught half done; the service starts again whatever happens.
dc stop minio >/dev/null 2>&1
trap 'dc start minio >/dev/null 2>&1' EXIT
dc run --rm --no-deps -T --entrypoint tar minio -C /home/minio -cf - data > "$dir/minio.tar"
dc start minio >/dev/null 2>&1
trap - EXIT
echo "backup: $dir in $(($(date +%s) - started)) s: $(cd "$dir" && du -ch -- * | tail -n 1 | cut -f 1)"

# Retention: the backups this script made, by their name, newest first; nothing else is touched.
mapfile -t backups < <(find "$target" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
  -regex '.*/[0-9]{8}T[0-9]{6}Z' -printf '%f\n' | sort -r)
for old in "${backups[@]:keep}"; do
  rm -rf -- "${target:?}/$old"
  echo "backup: removed $target/$old (keeping $keep)"
done
