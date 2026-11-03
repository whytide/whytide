#!/usr/bin/env bash
# The database roles of a deployment (README.md "Production"), run by the one-shot service
# postgres-setup before the api, as the superuser over the network: the login roles of the three
# connection strings in deploy/.env, the owner, who owns the database `app` and runs the migrations,
# and the roles of `app` and `billing_writer`, members of the group roles of core/packages/db's first
# migration, created here first when missing. Each run brings the roles to that state, so a second
# run changes nothing and a password changed in deploy/.env applies at the next `up`.
set -euo pipefail

fail() { printf 'postgres-setup: %s\n' "$*" >&2; exit 1; }

# The role and the password of a connection string. A password of URL-safe characters only, which
# needs no decoding here or in the apps (README.md says how to make one).
login() {
  local variable="$1" url="${!1:-}"
  [[ "$url" =~ ^postgres(ql)?://([a-z_][a-z0-9_]{0,62}):([A-Za-z0-9._~-]{16,})@postgres:5432/app(\?.*)?$ ]] ||
    fail "$variable is not a postgresql URL to the database app at postgres:5432 with a role and a password of 16 or more letters, digits, '.', '_', '~' or '-'"
  case "${BASH_REMATCH[2]}" in
    postgres | app | billing_writer) fail "$variable: the role ${BASH_REMATCH[2]} is reserved" ;;
  esac
  role="${BASH_REMATCH[2]}" password="${BASH_REMATCH[3]}"
}

sql() {
  echo "set client_min_messages to warning;"
  echo "do \$\$ begin"
  for group in app billing_writer; do
    echo "  if not exists (select from pg_roles where rolname = '$group') then create role $group nologin; end if;"
  done
  echo "end \$\$;"
  local role password variable
  for variable in DATABASE_URL_OWNER DATABASE_URL DATABASE_URL_BILLING_WRITER; do
    login "$variable"
    echo "do \$\$ begin"
    echo "  if exists (select from pg_roles where rolname = '$role') then alter role \"$role\" with login password '$password';"
    echo "  else create role \"$role\" login password '$password'; end if;"
    echo "end \$\$;"
    case "$variable" in
      DATABASE_URL_OWNER) echo "alter database app owner to \"$role\";" ;;
      DATABASE_URL) echo "grant app to \"$role\";" ;;
      DATABASE_URL_BILLING_WRITER) echo "grant billing_writer to \"$role\";" ;;
    esac
  done
}

roles="$(for variable in DATABASE_URL_OWNER DATABASE_URL DATABASE_URL_BILLING_WRITER; do login "$variable"; echo "$role"; done)"
[ "$(sort -u <<< "$roles" | wc -l)" -eq 3 ] || fail "the three connection strings need three different roles"
sql | psql -d postgres -v ON_ERROR_STOP=1 -q >/dev/null
echo "postgres-setup: roles $(tr '\n' ' ' <<< "$roles")ready; app owned by $(head -n 1 <<< "$roles")"
