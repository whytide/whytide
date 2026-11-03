#!/usr/bin/env bash
# One slice of the shared development stack per worktree (docs/rules/delivery.md §2): a database
# `app_<name>` on the running Postgres with its three login roles (`owner_<name>` owns it, `app_<name>`
# and `billing_writer_<name>` are members of the group roles `app` and `billing_writer` of
# core/packages/db), a Temporal namespace `<name>`, a Redis key prefix `<name>:`, a MinIO bucket
# `<name>` and three free localhost ports for the worktree's own api, web and worker, written to
# .env.local at the worktree's root from deploy/.env.example. The root scripts env:create,
# env:destroy and env:status call this. Nothing is started here: the stack is up already
# (`pnpm stack:up`), and psql, redis-cli, the temporal CLI and curl run inside its containers through
# `docker compose exec`, so the laptop needs Docker and pnpm only.
#   env.sh create [name] [--force]   create what is missing and write .env.local; --force rewrites an
#                                    existing .env.local (same slice, same ports, nothing wiped)
#   env.sh destroy                   drop the database and the roles, delete the namespace, the keys
#                                    under the prefix and the bucket; remove .env.local and the lock
#   env.sh status                    the slice and whether each part exists; exit 1 when one is missing
# The name is the worktree's folder name, lowercased with anything but letters, digits and hyphens
# turned into hyphens, or the argument as given. A lock file ~/.cache/whytide/slices/<name> names the
# worktree that holds a name and its ports, so two worktrees never share a slice or a port.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"
env_local="$root/.env.local"
example="$root/deploy/.env.example"
locks="${XDG_CACHE_HOME:-$HOME/.cache}/whytide/slices"

usage() { echo "usage: env.sh create [name] [--force] | destroy | status" >&2; exit 2; }
fail() { printf 'env: %s\n' "$*" >&2; exit 1; }
dc() { docker compose -f deploy/compose.yaml --profile '*' "$@"; }
psql() { dc exec -T postgres psql -U postgres -At -v ON_ERROR_STOP=1 "$@"; }
namespace() { dc exec -T temporal temporal operator namespace "$@"; }
redis() { dc exec -T redis redis-cli "$@"; }
published() { dc port "$1" "$2" | sed 's/.*://'; }
value() { sed -n "s/^$1=//p" "$env_local"; }
# An S3 request against the bucket, answered with its HTTP status. MinIO's image ships no client since
# mc was retired (images.md); the Temporal image's curl signs S3 requests and reaches MinIO over the
# Compose network. The credentials travel in the environment, not on a command line.
s3() { dc exec -T -e S3_KEY="$s3_key" -e S3_SECRET="$s3_secret" temporal sh -c \
  'curl -s --max-time 10 -o /dev/null -w "%{http_code}" --aws-sigv4 aws:amz:us-east-1:s3 --user "$S3_KEY:$S3_SECRET" "$@"' sh "$@"; }

# The slice's name: the argument, checked, or the worktree's folder name, made safe for a bucket, a
# database and a namespace alike (3 to 48 characters of lowercase letters, digits and hyphens).
slice_name() {
  local name="$1"
  if [ -z "$name" ]; then
    name="$(basename "$root" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  fi
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$ ]] ||
    fail "a slice name is 3 to 48 characters of lowercase letters, digits and hyphens, not '$name'"
  printf '%s' "$name"
}
lock_holder() { [ -f "$locks/$1" ] && sed -n 's/^worktree=//p' "$locks/$1" || true; }
# The database and the roles of the slice `name`; `billing_writer_` plus 48 characters is Postgres's
# limit on a name.
slice_names() { database="app_$name"; owner_role="owner_$name"; app_role="app_$name"; billing_role="billing_writer_$name"; }

# What the running stack publishes, read from the containers themselves, so a worktree without a
# deploy/.env of its own still finds the laptop's ports and passwords.
stack_facts() {
  local running
  running="$(dc ps --status running --services 2>/dev/null || true)"
  for service in postgres redis temporal minio mailpit; do
    grep -qx "$service" <<< "$running" || fail "the shared stack is not up ($service is not running): pnpm stack:up, see deploy/README.md"
  done
  pg_port="$(published postgres 5432)"
  pg_password="$(dc exec -T postgres printenv POSTGRES_PASSWORD)"
  redis_port="$(published redis 6379)"
  temporal_port="$(published temporal 7233)"
  minio_port="$(published minio 9000)"
  s3_key="$(dc exec -T minio printenv MINIO_ROOT_USER)"
  s3_secret="$(dc exec -T minio printenv MINIO_ROOT_PASSWORD)"
  mailpit_port="$(published mailpit 1025)"
  mailpit_api_port="$(published mailpit 8025)"
  otel_endpoint=""
  if grep -qx otel-lgtm <<< "$running"; then otel_endpoint="http://127.0.0.1:$(published otel-lgtm 4318)"; fi
}

# $1 ports to pick, the rest ports to avoid: free localhost ports, bound and released by node.
free_ports() {
  node -e '
    const net = require("node:net");
    const [want, ...avoid] = process.argv.slice(1).map(Number);
    const taken = new Set(avoid), picked = [], held = [];
    (function next() {
      if (picked.length === want) { console.log(picked.join(" ")); for (const s of held) s.close(); return; }
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        if (taken.has(port)) { server.close(); return next(); }
        picked.push(port); held.push(server); next();
      });
    })();' "$@"
}

database_exists() { [ "$(psql -d postgres -c "select 1 from pg_database where datname = '$database'")" = 1 ]; }
role_exists() { [ "$(psql -d postgres -c "select 1 from pg_roles where rolname = '$1'")" = 1 ]; }
roles_exist() { role_exists "$owner_role" && role_exists "$app_role" && role_exists "$billing_role"; }
# The slice's login roles (core/packages/db/README.md): the owner, who owns the database and may create
# one (`pnpm db:reset` recreates it; Prisma's migrate dev makes a shadow database), and a member each of
# the group roles `app` and `billing_writer`, which the first migration also creates when missing and
# which are created here first so the members can join them before it runs. Created or brought to this
# state, so a second run changes nothing. The password is the stack's own, read from its container: the
# stack listens on localhost only and its superuser carries the same one. The SQL travels on stdin.
create_roles() {
  local role attrs password="${pg_password//\'/\'\'}"
  {
    echo "set client_min_messages to warning;"
    for role in app billing_writer; do
      role_exists "$role" || echo "create role $role nologin;"
    done
    for role in "$owner_role login createdb" "$app_role login" "$billing_role login"; do
      attrs="${role#* }"; role="${role%% *}"
      if role_exists "$role"; then printf 'alter role "%s" with %s password '"'"'%s'"'"';\n' "$role" "$attrs" "$password"
      else printf 'create role "%s" %s password '"'"'%s'"'"';\n' "$role" "$attrs" "$password"; fi
    done
    echo "grant app to \"$app_role\"; grant billing_writer to \"$billing_role\";"
  } | psql -d postgres >/dev/null
}
# The roles go after the databases the owner holds, the slice's and a shadow database a crashed
# migrate dev left; a role that owns anything cannot be dropped.
drop_roles() {
  local owned
  owned="$(psql -d postgres -c "select datname from pg_database where datdba = (select oid from pg_roles where rolname = '$owner_role')")"
  for owned in $owned; do psql -d postgres -c "drop database \"$owned\" with (force)" >/dev/null; done
  psql -d postgres -c "drop role if exists \"$owner_role\", \"$app_role\", \"$billing_role\"" >/dev/null
}
# Retried twice on a transport error: the CLI in the container now and then fails to reach the server
# on a first try ("failed reaching server"), which is not "not found".
namespace_exists() {
  local try out
  for try in 1 2 3; do
    if out="$(namespace describe --namespace "$name" 2>&1)"; then return 0; fi
    grep -q 'not found' <<< "$out" && return 1
    sleep 2
  done
  fail "Temporal did not answer: $out"
}
bucket_status() { s3 -I "http://minio:9000/$name/"; }
key_count() { redis --scan --pattern "$name:*" | wc -l | tr -d ' '; }

# .env.local from the example: the slice's variables filled, a value marked `# secret` emptied, every
# other line copied as it is.
write_env_local() {
  local fills key
  fills="SLICE_NAME=$name
DATABASE_URL_OWNER=postgresql://$owner_role:$pg_password@127.0.0.1:$pg_port/$database
DATABASE_URL=postgresql://$app_role:$pg_password@127.0.0.1:$pg_port/$database
DATABASE_URL_BILLING_WRITER=postgresql://$billing_role:$pg_password@127.0.0.1:$pg_port/$database
REDIS_URL=redis://127.0.0.1:$redis_port
REDIS_PREFIX=$name:
TEMPORAL_ADDRESS=127.0.0.1:$temporal_port
TEMPORAL_NAMESPACE=$name
S3_ENDPOINT=http://127.0.0.1:$minio_port
S3_BUCKET=$name
S3_ACCESS_KEY=$s3_key
S3_SECRET_KEY=$s3_secret
SMTP_HOST=127.0.0.1
SMTP_PORT=$mailpit_port
MAILPIT_API_URL=http://127.0.0.1:$mailpit_api_port
OTEL_EXPORTER_OTLP_ENDPOINT=$otel_endpoint
API_PORT=$api_port
WEB_PORT=$web_port
WEB_DEV_ORIGIN=http://127.0.0.1:$web_port
WORKER_HEALTH_PORT=$worker_port"
  umask 077
  {
    printf '# Written by pnpm env:create for the slice %s of this worktree; never committed. Run it again with\n' "$name"
    printf '# --force when the stack moved a port. Every variable means what deploy/.env.example says.\n'
    awk -v fills="$fills" '
      BEGIN { n = split(fills, line, "\n"); for (i = 1; i <= n; i++) { eq = index(line[i], "="); fill[substr(line[i], 1, eq - 1)] = substr(line[i], eq + 1) } }
      /^[A-Za-z_][A-Za-z0-9_]*=/ {
        key = substr($0, 1, index($0, "=") - 1)
        if (key in fill) { print key "=" fill[key]; next }
        if ($0 ~ /#[ \t]*secret[ \t]*$/) { print key "= # secret"; next }
      }
      { print }' "$example"
  } > "$env_local.tmp"
  for key in $(sed -n 's/^\([A-Z_]*\)=.*/\1/p' <<< "$fills"); do
    grep -q "^$key=" "$env_local.tmp" || { rm -f "$env_local.tmp"; fail "deploy/.env.example lists no $key for env:create to fill"; }
  done
  mv "$env_local.tmp" "$env_local"
}

create() {
  local force=false requested="" current holder
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) force=true ;;
      -*) echo "unknown option: $1" >&2; usage ;;
      *) [ -z "$requested" ] || usage; requested="$1" ;;
    esac
    shift
  done
  name="$(slice_name "$requested")"
  slice_names
  if [ -f "$env_local" ]; then
    current="$(value SLICE_NAME)"
    [ "$force" = true ] || fail ".env.local exists in $root${current:+ (slice $current)}; pass --force to write it again"
    [ -z "$current" ] || [ "$current" = "$name" ] || fail ".env.local in $root belongs to the slice $current; run pnpm env:destroy before creating $name"
  fi
  holder="$(lock_holder "$name")"
  [ -z "$holder" ] || [ "$holder" = "$root" ] ||
    fail "the name $name is used by the worktree $holder ($locks/$name); pass another name, or run pnpm env:destroy there"
  stack_facts
  # The ports .env.local records stay, so a running api or web is not moved; new ones avoid every port
  # another slice on this laptop recorded, running or not.
  api_port=""; web_port=""; worker_port=""
  if [ -f "$env_local" ]; then api_port="$(value API_PORT)"; web_port="$(value WEB_PORT)"; worker_port="$(value WORKER_HEALTH_PORT)"; fi
  if [ -z "$api_port" ] || [ -z "$web_port" ] || [ -z "$worker_port" ]; then
    read -r api_port web_port worker_port <<< "$(free_ports 3 $(cat "$locks"/* 2>/dev/null | sed -n 's/^ports=//p'))"
  fi
  mkdir -p "$locks"
  printf 'worktree=%s\nports=%s %s %s\n' "$root" "$api_port" "$web_port" "$worker_port" > "$locks/$name"
  echo "slice $name of $root"
  create_roles
  echo "  roles      $owner_role, $app_role, $billing_role   ok"
  # A database from before the roles is handed to the owner; what the superuser created inside stays
  # the superuser's until `pnpm db:reset` recreates it.
  if database_exists; then psql -d postgres -c "alter database \"$database\" owner to \"$owner_role\"" >/dev/null; echo "  database   $database   exists"
  else psql -d postgres -c "create database \"$database\" owner \"$owner_role\"" >/dev/null; echo "  database   $database   created"; fi
  if namespace_exists; then echo "  namespace  $name   exists"
  else namespace create --namespace "$name" --description "whytide worktree $root" >/dev/null; echo "  namespace  $name   created"; fi
  echo "  prefix     $name:   $(key_count) keys"
  case "$(bucket_status)" in
    200) echo "  bucket     $name   exists" ;;
    404) [ "$(s3 -X PUT "http://minio:9000/$name/")" = 200 ] || fail "MinIO did not create the bucket $name"; echo "  bucket     $name   created" ;;
    *) fail "MinIO did not answer for the bucket $name (HTTP $(bucket_status))" ;;
  esac
  write_env_local
  echo "  ports      api $api_port, web $web_port, worker $worker_port"
  echo "  .env.local written"
}

destroy() {
  [ $# -eq 0 ] || usage
  local holder keys
  name=""
  [ ! -f "$env_local" ] || name="$(value SLICE_NAME)"
  name="$(slice_name "$name")"
  slice_names
  holder="$(lock_holder "$name")"
  [ -z "$holder" ] || [ "$holder" = "$root" ] || fail "the slice $name belongs to the worktree $holder; nothing removed"
  stack_facts
  echo "slice $name of $root"
  if database_exists; then psql -d postgres -c "drop database \"$database\" with (force)" >/dev/null; echo "  database   $database   dropped"
  else echo "  database   $database   already gone"; fi
  if roles_exist; then drop_roles; echo "  roles      $owner_role, $app_role, $billing_role   dropped"
  else drop_roles; echo "  roles      $owner_role, $app_role, $billing_role   already gone"; fi
  if namespace_exists; then namespace delete --namespace "$name" --yes >/dev/null; echo "  namespace  $name   deleted"
  else echo "  namespace  $name   already gone"; fi
  keys="$(key_count)"
  dc exec -T redis sh -c 'redis-cli --scan --pattern "$1" | xargs -r redis-cli del >/dev/null' sh "$name:*"
  echo "  prefix     $name:   $keys keys deleted"
  # The header is what `mc rb --force` sends: the bucket goes with its objects.
  case "$(s3 -X DELETE -H 'x-minio-force-delete: true' "http://minio:9000/$name/")" in
    204) echo "  bucket     $name   deleted" ;;
    404) echo "  bucket     $name   already gone" ;;
    *) fail "MinIO did not delete the bucket $name" ;;
  esac
  rm -f "$env_local" "$locks/$name"
  echo "  .env.local and the lock removed"
}

status() {
  [ $# -eq 0 ] || usage
  local missing=0 holder
  name=""
  [ ! -f "$env_local" ] || name="$(value SLICE_NAME)"
  if [ -n "$name" ]; then echo "slice $name of $root"
  else name="$(slice_name "")"; echo "slice $name of $root: no .env.local, run pnpm env:create"; missing=1; fi
  slice_names
  holder="$(lock_holder "$name")"
  if [ "$holder" = "$root" ]; then echo "  lock       $locks/$name   ok"
  elif [ -n "$holder" ]; then echo "  lock       $locks/$name   held by $holder"; missing=1
  else echo "  lock       $locks/$name   missing"; missing=1; fi
  stack_facts
  if roles_exist; then echo "  roles      $owner_role, $app_role, $billing_role   ok"; else echo "  roles      $owner_role, $app_role, $billing_role   missing"; missing=1; fi
  if database_exists; then echo "  database   $database   ok"; else echo "  database   $database   missing"; missing=1; fi
  if namespace_exists; then echo "  namespace  $name   ok"; else echo "  namespace  $name   missing"; missing=1; fi
  echo "  prefix     $name:   $(key_count) keys"
  if [ "$(bucket_status)" = 200 ]; then echo "  bucket     $name   ok"; else echo "  bucket     $name   missing"; missing=1; fi
  if [ -f "$env_local" ]; then echo "  ports      api $(value API_PORT), web $(value WEB_PORT), worker $(value WORKER_HEALTH_PORT)"; fi
  return "$missing"
}

command="${1:-}"
[ $# -eq 0 ] || shift
case "$command" in
  create) create "$@" ;;
  destroy) destroy "$@" ;;
  status) status "$@" ;;
  *) usage ;;
esac
