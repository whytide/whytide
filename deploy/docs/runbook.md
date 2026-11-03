# Runbook: production

For the one-server install of [../README.md](../README.md) "Production". Every command runs in `deploy/` on the server, as a user who may run Docker.

## Health

- `docker compose ps`: every service `running`, and `healthy` where it has a check; `postgres-setup` and `minio-setup` exited 0.
- `curl https://<domain>/api/health`: 200 with `{"status":"ok", "checks":{…}}`; 503 names the failing check (`database`, `migrations`, `redis`).
- `docker compose logs -f api` (or `worker`, `web`, `caddy`): JSON lines; a failed start names its code, a failed migration its name, and the api never listens then.
- **Redis down:** the rate limits let requests through and log a warning once a minute, `/health` answers 503 naming `redis`, and Compose marks the api `unhealthy`. Caddy does not check health, so the app keeps serving. `docker compose restart redis`; nothing is lost, Redis keeps nothing durable.

## Backup

`./backup.sh /var/backups/whytide --keep 7` writes `<UTC time>/` with `app.dump`, `temporal.dump`, `temporal_visibility.dump` (pg_dump, custom format) and `minio.tar` (MinIO's folder, copied while MinIO stops for those seconds), readable by its owner only, then keeps the newest seven. Run it daily from cron, and copy the folder off the server with the host's own job.

- Not in a backup: `deploy/.env`, which holds the master key, `HASH_SALT` and the passwords. Keep a copy in a password manager: a backup without its master key cannot decrypt the secrets at rest, nor match an erased person without its `HASH_SALT`. Caddy's certificates are not kept either; it gets new ones.
- A backup holds personal data: keep it where the server's data may go, and delete it on the same schedule.

## Restore

Into a fresh stack only: a new server with the same `deploy/.env`, or this one after `docker compose down --volumes`, which deletes every database and file. `restore.sh` refuses a project that has volumes.

1. `docker compose down --volumes` (on this server), or the install's steps 1 to 4 (on a new one).
2. `./restore.sh /var/backups/whytide/<UTC time>`: Postgres alone, `postgres-setup`, the three databases with pg_restore, MinIO's folder, then the whole stack, waiting for health.
3. `https://<domain>/api/health` answers 200, and a tester signs in.

The drill, the same steps on a fixture, runs in `tests/production.test.ts` and takes under two minutes on a laptop; practise it on a copy every quarter.

## Upgrade

1. `./backup.sh /var/backups/whytide` first.
2. The new release's images (`bash scripts/images-build.sh` at its commit, or a pull), and its tag in `IMAGE_TAG` in `.env`; run `pnpm deploy:check` when the release changed `.env.production.example`.
3. `docker compose up -d --wait`: the api applies the new migrations before it listens; the worker and the web restart after it.

A release that moves Prisma needs a new pin of the schema engine (`images.md` "Prisma's schema engine"): the image build fails until it has one.

## Rollback

The previous tag in `IMAGE_TAG`, then `docker compose up -d --wait`, when the release added no migration (`core/packages/db/prisma/migrations/`). Migrations only go forward: after one, restore the backup made before the upgrade, then start the previous tag.

## Secrets

A new password or key goes in `.env`, then `docker compose up -d`: `postgres-setup` sets the roles' passwords again, and the apps restart with the new environment. A new `AUTH_SECRET` signs everyone out. `APP_MASTER_KEY` is never replaced without its rotation (the previous key in `APP_MASTER_KEY_PREVIOUS`, zeta).
