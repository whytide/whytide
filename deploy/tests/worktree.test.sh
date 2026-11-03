#!/usr/bin/env bash
# The end-to-end test of the worktree scripts (alpha-p0-040), run by `pnpm -F deploy test` after
# tests/stack.test.sh. It needs this laptop's shared stack up (`pnpm stack:up`): it adds two temporary
# git worktrees of this clone, runs `pnpm env:create`, `env:status` and `env:destroy` in each through
# the real root scripts, and asserts that the two slices differ in every part, that every part exists
# in the running stack, the three login roles of each slice included (alpha-p1-010), that nothing was
# started, that `.env.local` copies no secret, that the guards refuse, that `--force` changes nothing,
# and that destroying one slice leaves the other intact; then it removes the worktrees and whatever a
# failed run left behind.
set -euo pipefail

root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
dc() { docker compose -f deploy/compose.yaml --profile '*' "$@"; }
psql() { dc exec -T postgres psql -U postgres -At -v ON_ERROR_STOP=1 "$@"; }
redis() { dc exec -T redis redis-cli "$@"; }
# Whether Temporal lists a namespace, retried on a transport error the way the scripts do.
namespace_exists() {
  local try out
  for try in 1 2 3; do
    if out="$(dc exec -T temporal temporal operator namespace describe --namespace "$1" 2>&1)"; then return 0; fi
    grep -q 'not found' <<< "$out" && return 1
    sleep 2
  done
  fail "Temporal did not answer: $out"
}
in_wt() { local wt="$1"; shift; (cd "$wt" && pnpm -s "$@"); }
value() { sed -n "s/^$2=//p" "$1/.env.local"; }
published() { dc port "$1" "$2" | sed 's/.*://'; }
# The HTTP status of a bucket, and an object put into one, through the S3 API with the credentials a
# worktree's .env.local holds, signed by the curl of the Temporal image like the scripts do.
s3() { local wt="$1"; shift; dc exec -T -e S3_KEY="$(value "$wt" S3_ACCESS_KEY)" -e S3_SECRET="$(value "$wt" S3_SECRET_KEY)" temporal sh -c \
  'curl -s --max-time 10 -o /dev/null -w "%{http_code}" --aws-sigv4 aws:amz:us-east-1:s3 --user "$S3_KEY:$S3_SECRET" "$@"' sh "$@"; }
bucket() { s3 "$1" -I "http://minio:9000/$2/"; }
role_exists() { [ "$(psql -d postgres -c "select 1 from pg_roles where rolname = '$1'")" = 1 ]; }
# `select current_user` over TCP as the role a worktree's URL names, with that URL's password: the
# role can log in. The password travels in the environment, not on a command line.
login_as() { local url; url="$(value "$1" "$2")"; dc exec -T -e PGPASSWORD="$(sed -E 's#^[^:]+://[^:]+:([^@]+)@.*$#\1#' <<< "$url")" postgres \
  psql -At -h 127.0.0.1 -U "$(sed -E 's#^[^:]+://([^:]+):.*$#\1#' <<< "$url")" -d "app_$3" -c 'select current_user'; }
put_object() { s3 "$1" -X PUT --data-binary probe "http://minio:9000/$2/$3"; }

for tool in docker node pnpm git; do command -v "$tool" >/dev/null || fail "$tool is needed"; done
running="$(dc ps --status running --services)"
for service in postgres redis temporal minio mailpit; do
  grep -qx "$service" <<< "$running" || fail "the shared stack is not up ($service is not running): pnpm stack:up"
done

step "two temporary worktrees of this clone; their folder names become the slice names"
suffix="$(date +%s)-$$"
tmp="$(mktemp -d)"
a="$tmp/wt-$suffix-a"
b="$tmp/wt-$suffix-b"
locks="${XDG_CACHE_HOME:-$HOME/.cache}/whytide/slices"
on_exit() {
  status=$?
  printf '\n== remove the worktrees and what is left of their slices\n'
  for wt in "$a" "$b"; do
    if [ -f "$wt/.env.local" ]; then in_wt "$wt" env:destroy >/dev/null 2>&1 || true; fi
    git worktree remove --force "$wt" >/dev/null 2>&1 || true
  done
  git worktree prune
  rm -rf "$tmp" "$locks/wt-$suffix-a" "$locks/wt-$suffix-b"
  exit "$status"
}
trap on_exit EXIT
git worktree add --quiet --detach "$a" HEAD
git worktree add --quiet --detach "$b" HEAD
[ ! -e "$a/deploy/.env" ] || fail "a fresh worktree carries a deploy/.env"
echo "$a"; echo "$b"
containers_before="$(docker ps -q | sort)"

step "env:create in the first worktree; a secret marked in its example must not be copied"
printf 'TEST_SECRET=example-value # secret\n' >> "$a/deploy/.env.example"
in_wt "$a" env:create
[ -f "$a/.env.local" ] || fail ".env.local is missing"
name_a="$(value "$a" SLICE_NAME)"
[ "$name_a" = "wt-$suffix-a" ] || fail "the slice name is not the folder name: $name_a"

step "a name another worktree uses is refused before anything is created"
if out="$(in_wt "$b" env:create "$name_a" 2>&1)"; then fail "env:create took the name of the first worktree's slice"; fi
grep -qF "$a" <<< "$out" || fail "the refusal does not name the worktree that holds the slice: $out"
[ ! -e "$b/.env.local" ] || fail "the refused env:create wrote .env.local"

step "env:create in the second worktree"
in_wt "$b" env:create
name_b="$(value "$b" SLICE_NAME)"
[ "$name_b" = "wt-$suffix-b" ] || fail "the slice name is not the folder name: $name_b"

step "the two slices differ in every part, and each part is named after the slice"
for key in SLICE_NAME DATABASE_URL_OWNER DATABASE_URL DATABASE_URL_BILLING_WRITER TEMPORAL_NAMESPACE REDIS_PREFIX S3_BUCKET API_PORT WEB_PORT WEB_DEV_ORIGIN WORKER_HEALTH_PORT; do
  va="$(value "$a" "$key")"; vb="$(value "$b" "$key")"
  [ -n "$va" ] && [ -n "$vb" ] || fail "$key is empty in a worktree's .env.local"
  [ "$va" != "$vb" ] || fail "$key is the same in both worktrees: $va"
done
for wt in "$a" "$b"; do
  name="$(value "$wt" SLICE_NAME)"
  for pair in "DATABASE_URL_OWNER owner_$name" "DATABASE_URL app_$name" "DATABASE_URL_BILLING_WRITER billing_writer_$name"; do
    key="${pair% *}"; role="${pair#* }"
    case "$(value "$wt" "$key")" in postgresql://"$role":*@127.0.0.1:"$(published postgres 5432)"/app_"$name") ;; *) fail "$key of $name: $(value "$wt" "$key" | sed 's#:[^:@]*@#:…@#')" ;; esac
  done
  [ "$(value "$wt" REDIS_URL)" = "redis://127.0.0.1:$(published redis 6379)" ] || fail "REDIS_URL of $name is not the published Redis"
  [ "$(value "$wt" REDIS_PREFIX)" = "$name:" ] || fail "REDIS_PREFIX of $name"
  [ "$(value "$wt" TEMPORAL_ADDRESS)" = "127.0.0.1:$(published temporal 7233)" ] || fail "TEMPORAL_ADDRESS of $name is not the published Temporal"
  [ "$(value "$wt" TEMPORAL_NAMESPACE)" = "$name" ] || fail "TEMPORAL_NAMESPACE of $name"
  [ "$(value "$wt" S3_ENDPOINT)" = "http://127.0.0.1:$(published minio 9000)" ] || fail "S3_ENDPOINT of $name is not the published MinIO"
  [ "$(value "$wt" S3_BUCKET)" = "$name" ] || fail "S3_BUCKET of $name"
done
ports="$(for wt in "$a" "$b"; do for key in API_PORT WEB_PORT WORKER_HEALTH_PORT; do value "$wt" "$key"; done; done)"
[ "$(sort -u <<< "$ports" | wc -l)" -eq 6 ] || fail "the six ports are not distinct: $(tr '\n' ' ' <<< "$ports")"
for p in $ports; do [ "$p" -ge 1024 ] && [ "$p" -le 65535 ] || fail "not a port: $p"; done
echo "ports: $(tr '\n' ' ' <<< "$ports")"

step "every part of each slice exists in the running stack"
databases="$(psql -d postgres -c 'select datname from pg_database')"
for wt in "$a" "$b"; do
  name="$(value "$wt" SLICE_NAME)"
  grep -qx "app_$name" <<< "$databases" || fail "database app_$name is missing"
  [ "$(psql -d postgres -c "select pg_get_userbyid(datdba) from pg_database where datname = 'app_$name'")" = "owner_$name" ] || fail "database app_$name is not owned by owner_$name"
  for role in "owner_$name" "app_$name" "billing_writer_$name"; do role_exists "$role" || fail "role $role is missing"; done
  [ "$(psql -d postgres -c "select pg_has_role('app_$name', 'app', 'member') and pg_has_role('billing_writer_$name', 'billing_writer', 'member') and not pg_has_role('app_$name', 'billing_writer', 'member')")" = t ] || fail "the login roles of $name are not members of their group roles only"
  [ "$(login_as "$wt" DATABASE_URL "$name")" = "app_$name" ] || fail "cannot log in as app_$name with the URL in .env.local"
  [ "$(login_as "$wt" DATABASE_URL_BILLING_WRITER "$name")" = "billing_writer_$name" ] || fail "cannot log in as billing_writer_$name"
  namespace_exists "$name" || fail "namespace $name is missing"
  [ "$(bucket "$wt" "$name")" = 200 ] || fail "bucket $name is missing"
  [ -f "$locks/$name" ] || fail "the lock $locks/$name is missing"
  grep -qF "$wt" "$locks/$name" || fail "the lock does not name the worktree: $(cat "$locks/$name")"
  redis set "$name:probe" 1 >/dev/null
done

step "the group roles app and billing_writer exist once, without a login"
[ "$(psql -d postgres -c "select count(*) from pg_roles where rolname in ('app', 'billing_writer') and not rolcanlogin")" = 2 ] || fail "the group roles are missing or can log in"

step "Mailpit and the observability container are shared as they are"
for wt in "$a" "$b"; do
  [ "$(value "$wt" SMTP_HOST)" = 127.0.0.1 ] || fail "SMTP_HOST is not localhost"
  [ "$(value "$wt" SMTP_PORT)" = "$(published mailpit 1025)" ] || fail "SMTP_PORT is not Mailpit's published port"
  [ "$(value "$wt" MAILPIT_API_URL)" = "http://127.0.0.1:$(published mailpit 8025)" ] || fail "MAILPIT_API_URL is not Mailpit's published API"
  if grep -qx otel-lgtm <<< "$running"; then
    [ "$(value "$wt" OTEL_EXPORTER_OTLP_ENDPOINT)" = "http://127.0.0.1:$(published otel-lgtm 4318)" ] || fail "OTEL_EXPORTER_OTLP_ENDPOINT is not the observability container"
  else
    [ -z "$(value "$wt" OTEL_EXPORTER_OTLP_ENDPOINT)" ] || fail "OTEL_EXPORTER_OTLP_ENDPOINT is set while the observability container is not running"
  fi
done

step "nothing was started: the same containers before and after"
[ "$(docker ps -q | sort)" = "$containers_before" ] || fail "env:create changed the running containers"

step ".env.local: no secret copied, every other variable at the example's default"
grep -qx 'TEST_SECRET= # secret' "$a/.env.local" || fail "the secret marked in the example was copied: $(grep '^TEST_SECRET' "$a/.env.local")"
! grep -E '^[A-Za-z_][A-Za-z0-9_]*=[[:space:]]*[^[:space:]#].*#[[:space:]]*secret[[:space:]]*$' "$a/.env.local" "$b/.env.local" || fail "a line marked # secret carries a value"
grep -qx 'DEV_POSTGRES_PORT=5432' "$a/.env.local" || fail "a variable env:create does not fill lost the example's default"
! grep -q 'TEST_SECRET' "$b/.env.local" || fail "the second worktree's .env.local came from the first's example"

step "env:status in each worktree shows its own slice, every part present"
status_a="$(in_wt "$a" env:status)"
echo "$status_a"
grep -qF "app_$name_a" <<< "$status_a" || fail "env:status in the first worktree does not show its database"
! grep -qF "$name_b" <<< "$status_a" || fail "env:status in the first worktree shows the second's slice"
! grep -qi missing <<< "$status_a" || fail "env:status reports a missing part"
status_b="$(in_wt "$b" env:status)"
grep -qF "app_$name_b" <<< "$status_b" || fail "env:status in the second worktree does not show its database"
! grep -qF "$name_a" <<< "$status_b" || fail "env:status in the second worktree shows the first's slice"

step "env:create refuses to run over an existing .env.local without --force"
if out="$(in_wt "$a" env:create 2>&1)"; then fail "env:create ran again over an existing .env.local"; fi
grep -qF '.env.local' <<< "$out" && grep -qF -- '--force' <<< "$out" || fail "the refusal does not say why or what to do: $out"

step "env:create --force ends in the same state"
cp "$a/.env.local" "$tmp/a.env.before"
in_wt "$a" env:create --force
cmp -s "$a/.env.local" "$tmp/a.env.before" || fail "--force changed .env.local: $(diff "$tmp/a.env.before" "$a/.env.local" || true)"
[ "$(docker ps -q | sort)" = "$containers_before" ] || fail "env:create --force changed the running containers"
[ "$(redis get "$name_a:probe")" = 1 ] || fail "--force wiped the keys under the prefix"
[ "$(bucket "$a" "$name_a")" = 200 ] || fail "bucket $name_a is missing after --force"

step "env:destroy removes exactly the first worktree's slice, bucket contents included"
[ "$(put_object "$a" "$name_a" probe.txt)" = 200 ] || fail "cannot put an object into bucket $name_a"
in_wt "$a" env:destroy
[ ! -e "$a/.env.local" ] || fail ".env.local remains after env:destroy"
[ ! -e "$locks/$name_a" ] || fail "the lock remains after env:destroy"
databases="$(psql -d postgres -c 'select datname from pg_database')"
! grep -qx "app_$name_a" <<< "$databases" || fail "database app_$name_a remains"
grep -qx "app_$name_b" <<< "$databases" || fail "the second worktree's database is gone"
for role in "owner_$name_a" "app_$name_a" "billing_writer_$name_a"; do ! role_exists "$role" || fail "role $role remains"; done
for role in "owner_$name_b" "app_$name_b" "billing_writer_$name_b" app billing_writer; do role_exists "$role" || fail "role $role is gone"; done
! namespace_exists "$name_a" || fail "namespace $name_a remains"
namespace_exists "$name_b" || fail "the second worktree's namespace is gone"
[ "$(redis exists "$name_a:probe")" = 0 ] || fail "keys under $name_a: remain"
[ "$(redis exists "$name_b:probe")" = 1 ] || fail "the second worktree's keys are gone"
[ "$(bucket "$b" "$name_a")" = 404 ] || fail "bucket $name_a remains: $(bucket "$b" "$name_a")"
[ "$(bucket "$b" "$name_b")" = 200 ] || fail "the second worktree's bucket is gone"
[ -f "$locks/$name_b" ] || fail "the second worktree's lock is gone"
if in_wt "$a" env:status >/dev/null 2>&1; then fail "env:status succeeds in a worktree without a slice"; fi

step "env:destroy in the second worktree"
in_wt "$b" env:destroy
[ ! -e "$b/.env.local" ] || fail ".env.local remains after env:destroy"
! grep -qx "app_$name_b" <<< "$(psql -d postgres -c 'select datname from pg_database')" || fail "database app_$name_b remains"
! role_exists "owner_$name_b" || fail "role owner_$name_b remains"
[ "$(bucket "$a" "$name_b" 2>/dev/null || true)" != 200 ] || fail "bucket $name_b remains"
[ "$(docker ps -q | sort)" = "$containers_before" ] || fail "env:destroy changed the running containers"

printf '\nworktree test: ok\n'
