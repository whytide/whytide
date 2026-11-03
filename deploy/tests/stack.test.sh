#!/usr/bin/env bash
# The end-to-end test of the shared development stack (alpha-p0-030), run by `pnpm -F deploy test`;
# also the first half of the Compose smoke test. It drives the real wrappers (`pnpm stack:up`,
# `stack:status`, `stack:down`) against a throwaway Compose project on free localhost ports, so the
# laptop's own stack, when one is up, is never touched: it starts the stack with every profile, waits
# for health, asserts the databases, the extension, the MinIO and Mailpit endpoints and the
# localhost-only ports, proves a second `up` starts nothing, that `down` keeps the volumes and
# `down --wipe` removes them, then removes everything it created.
set -euo pipefail

root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
compose=deploy/compose.yaml

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
dc() { docker compose -f "$compose" --profile '*' "$@"; }
psql() { dc exec -T postgres psql -U postgres -At -v ON_ERROR_STOP=1 "$@"; }
container() { dc ps -q "$1"; }
http() { curl -fsS --max-time 10 "$@"; }
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

for tool in docker curl node pnpm; do command -v "$tool" >/dev/null || fail "$tool is needed"; done
docker info >/dev/null 2>&1 || fail "the Docker daemon is not reachable"

step "static: every image is pinned by digest and listed in deploy/images.md, but our own"
# Our own, the api's, the worker's and the web's, are tagged by commit (scripts/images-build.sh);
# Dockerfile's bases and the schema engine's pin are listed too.
own="$(awk '$1 == "image:" && $2 ~ /^\$\{IMAGE_REGISTRY/ {print $2}' "$compose")"
[ "$(wc -w <<< "$own")" -eq 3 ] || fail "expected the api's, the worker's and the web's images in $compose, found: $own"
images="$(awk '$1 == "image:" && $2 !~ /^\$\{IMAGE_REGISTRY/ {print $2}' "$compose" | sort -u)"
[ "$(wc -w <<< "$images")" -eq 8 ] || fail "expected 8 pinned images in $compose, found: $images"
bases="$(awk '$1 == "FROM" && $2 ~ /@/ {print $2}' deploy/Dockerfile)"
[ "$(wc -w <<< "$bases")" -eq 1 ] || fail "expected one pinned base in deploy/Dockerfile, found: $bases"
for ref in $images $bases; do
  case "$ref" in *@sha256:*) ;; *) fail "$ref is not pinned by digest" ;; esac
  grep -F "${ref#*@}" deploy/images.md | grep -F -q "${ref%@*}" || fail "$ref is not listed in deploy/images.md"
done
for pin in PRISMA_ENGINES_COMMIT SCHEMA_ENGINE_GZ_SHA256 SCHEMA_ENGINE_SHA256; do
  value="$(sed -n "s/^ARG $pin=//p" deploy/Dockerfile)"
  [ -n "$value" ] && grep -F -q "\`$value\`" deploy/images.md || fail "$pin of deploy/Dockerfile is not in deploy/images.md"
done

step "static: the DEV_* defaults in compose.yaml match deploy/.env.example"
while IFS='=' read -r key value; do
  grep -F -q "\${$key:-$value}" "$compose" || fail "$key=$value in deploy/.env.example, another default in compose.yaml"
done < <(grep -E '^DEV_[A-Z_]+=' deploy/.env.example)
for key in $(grep -o '\${DEV_[A-Z_]*' "$compose" | tr -d '${' | sort -u); do
  grep -q "^$key=" deploy/.env.example || fail "$key is used in compose.yaml but not listed in deploy/.env.example"
done

step "static: compose.yaml is valid with every profile"
dc config -q

step "a throwaway project on free localhost ports"
export COMPOSE_PROJECT_NAME=whytide-stack-test
read -r DEV_POSTGRES_PORT DEV_REDIS_PORT DEV_TEMPORAL_PORT DEV_TEMPORAL_UI_PORT DEV_MINIO_PORT \
  DEV_MINIO_CONSOLE_PORT DEV_MAILPIT_PORT DEV_MAILPIT_UI_PORT DEV_OTEL_PORT DEV_OTEL_GRPC_PORT \
  DEV_GRAFANA_PORT <<< "$(node -e '
    const net = require("node:net");
    const servers = Array.from({ length: Number(process.argv[1]) }, () => net.createServer());
    let waiting = servers.length;
    for (const s of servers) s.listen(0, "127.0.0.1", () => {
      if (--waiting > 0) return;
      console.log(servers.map((x) => x.address().port).join(" "));
      for (const x of servers) x.close();
    });' 11)"
export DEV_POSTGRES_PORT DEV_REDIS_PORT DEV_TEMPORAL_PORT DEV_TEMPORAL_UI_PORT DEV_MINIO_PORT \
  DEV_MINIO_CONSOLE_PORT DEV_MAILPIT_PORT DEV_MAILPIT_UI_PORT DEV_OTEL_PORT DEV_OTEL_GRPC_PORT DEV_GRAFANA_PORT
export DEV_POSTGRES_PASSWORD=stack-test DEV_MINIO_ROOT_USER=stacktest DEV_MINIO_ROOT_PASSWORD=stack-test-minio
echo "project $COMPOSE_PROJECT_NAME: postgres $DEV_POSTGRES_PORT, redis $DEV_REDIS_PORT, temporal $DEV_TEMPORAL_PORT," \
  "minio $DEV_MINIO_PORT, mailpit $DEV_MAILPIT_PORT, otlp $DEV_OTEL_PORT"
on_exit() {
  status=$?
  if [ "$status" -ne 0 ]; then
    printf '\n== the last log lines of every service\n'
    dc logs --tail=30 2>/dev/null || true
  fi
  printf '\n== remove the throwaway project\n'
  pnpm -s stack:down --wipe >/dev/null 2>&1 || true
  exit "$status"
}
trap on_exit EXIT
pnpm -s stack:down --wipe >/dev/null 2>&1 || true

step "stack:up with every profile on a clean project"
started=$(date +%s)
pnpm -s stack:up --profile observability --profile tools
echo "every service healthy after $(( $(date +%s) - started )) s (the wrapper waits at most 90 s)"

step "stack:status shows every service healthy"
pnpm -s stack:status
services="postgres redis temporal temporal-ui minio mailpit otel-lgtm"
for service in $services; do
  id="$(container "$service")"
  [ -n "$id" ] || fail "$service has no container"
  health="$(docker inspect --format '{{.State.Health.Status}}' "$id")"
  [ "$health" = healthy ] || fail "$service is $health, not healthy"
  name="$(docker inspect --format '{{.Name}}' "$id")"
  [ "$name" = "/$COMPOSE_PROJECT_NAME-$service" ] || fail "$service's container is named $name, not /$COMPOSE_PROJECT_NAME-$service"
done
[ "$(dc ps -q | wc -l)" -eq 7 ] || fail "expected 7 containers: $(dc ps -q | wc -l)"

step "Temporal's two databases live on the postgres service; app has the vector extension"
databases="$(psql -d app -c 'select datname from pg_database order by 1')"
for db in app temporal temporal_visibility; do
  grep -qx "$db" <<< "$databases" || fail "database $db is missing; found: $(tr '\n' ' ' <<< "$databases")"
done
psql -d app -c 'select extname from pg_extension' | grep -qx vector || fail "the vector extension is missing on app"
psql -d template1 -c 'select extname from pg_extension' | grep -qx vector || fail "the vector extension is missing on template1"
for db in temporal temporal_visibility; do
  tables="$(psql -d "$db" -c "select count(*) from information_schema.tables where table_schema = 'public'")"
  [ "$tables" -gt 0 ] || fail "Temporal's schema is not in the $db database"
done
psql -d app -c 'create table stack_test_marker (id int)'
dc exec -T temporal temporal operator cluster health | grep -q SERVING || fail "temporal is not SERVING"
dc exec -T temporal temporal operator namespace describe default >/dev/null || fail "the default namespace is missing"
port_open "$DEV_TEMPORAL_PORT" || fail "temporal does not answer on 127.0.0.1:$DEV_TEMPORAL_PORT"
port_open "$DEV_POSTGRES_PORT" || fail "postgres does not answer on 127.0.0.1:$DEV_POSTGRES_PORT"

step "Redis answers and keeps nothing on disk"
[ "$(dc exec -T redis redis-cli ping)" = PONG ] || fail "redis did not answer PONG"
[ "$(dc exec -T redis redis-cli config get appendonly | tail -n 1)" = no ] || fail "redis has appendonly on"
[ -z "$(dc exec -T redis redis-cli config get save | tail -n 1)" ] || fail "redis has RDB snapshots on"
port_open "$DEV_REDIS_PORT" || fail "redis does not answer on 127.0.0.1:$DEV_REDIS_PORT"

step "the MinIO and Mailpit endpoints answer, with the root user from the environment"
http "http://127.0.0.1:$DEV_MINIO_PORT/minio/health/live" -o /dev/null || fail "minio health endpoint"
login() { curl -s --max-time 10 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$DEV_MINIO_CONSOLE_PORT/api/v1/login" \
  -H 'content-type: application/json' -d "{\"accessKey\":\"$1\",\"secretKey\":\"$2\"}"; }
[ "$(login "$DEV_MINIO_ROOT_USER" "$DEV_MINIO_ROOT_PASSWORD")" = 204 ] || fail "the MinIO root user cannot sign in"
[ "$(login "$DEV_MINIO_ROOT_USER" wrong-password)" = 401 ] || fail "MinIO accepted a wrong password"
http "http://127.0.0.1:$DEV_MAILPIT_UI_PORT/api/v1/info" | grep -q '"Version"' || fail "mailpit API"
exec 3<>"/dev/tcp/127.0.0.1/$DEV_MAILPIT_PORT" && read -r -t 10 banner <&3 && exec 3>&-
[[ "$banner" == 220* ]] || fail "mailpit SMTP banner: $banner"

step "the observability container and the Temporal UI answer"
http "http://127.0.0.1:$DEV_GRAFANA_PORT/api/health" | grep -q '"database": *"ok"' || fail "grafana health"
http -X POST "http://127.0.0.1:$DEV_OTEL_PORT/v1/traces" -H 'content-type: application/json' \
  -d '{"resourceSpans":[]}' >/dev/null || fail "the OTLP/HTTP endpoint rejected an empty export"
port_open "$DEV_OTEL_GRPC_PORT" || fail "the OTLP/gRPC port is closed"
http "http://127.0.0.1:$DEV_TEMPORAL_UI_PORT/" -o /dev/null || fail "temporal-ui"

step "no service publishes a port on anything but localhost"
published="$(for id in $(dc ps -q); do
  docker inspect --format '{{$n := .Name}}{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{$n}} {{$p}} {{.HostIp}}:{{.HostPort}}{{"\n"}}{{end}}{{end}}' "$id"
done | sed '/^$/d')"
echo "$published"
[ "$(wc -l <<< "$published")" -ge 11 ] || fail "expected at least 11 published ports"
grep -v ' 127\.0\.0\.1:' <<< "$published" && fail "a port is published on a non-localhost address" || true

step "a second stack:up creates nothing"
before="$(dc ps -q | sort)"
pnpm -s stack:up --profile observability --profile tools
[ "$(dc ps -q | sort)" = "$before" ] || fail "the second up changed the containers"

step "stack:down keeps the volumes and the data"
pnpm -s stack:down
[ -z "$(dc ps -q)" ] || fail "containers remain after stack:down"
volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" | sort)"
for v in minio otel-lgtm postgres; do grep -qx "${COMPOSE_PROJECT_NAME}_$v" <<< "$volumes" || fail "volume $v is gone after stack:down"; done
pnpm -s stack:up
psql -d app -c 'select count(*) from stack_test_marker' >/dev/null || fail "the postgres volume did not keep its data"

step "stack:down --wipe removes the volumes"
pnpm -s stack:down --wipe
[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ] || fail "volumes remain after --wipe"
[ -z "$(dc ps -aq)" ] || fail "containers remain after --wipe"

printf '\nstack test: ok\n'
