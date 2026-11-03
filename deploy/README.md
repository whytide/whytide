# deploy/

The Compose file of development and production, the environment examples, the images and their table, the Caddyfile, the backup and restore scripts, and their tests (docs/architecture.md §18 and §19). Every change here takes two reviews (docs/rules/security.md §8).

`.env.example` lists every environment variable with a default, one block per package and module with a header, in module order (docs/rules/coding.md §8). A task adds its variables to its block. Copy it to `.env.local` at the repository root to run locally; `.env.local` is ignored by git and never committed (docs/rules/security.md §4).

## The development stack

One Compose project per laptop, `whytide`, shared by every worktree and never started a second time per task (docs/rules/delivery.md §2): `compose.yaml` with the profile `dev`. Start it once, from any worktree:

| Command | Does |
|---|---|
| `pnpm stack:up` | starts Postgres, Redis, Temporal, MinIO and Mailpit and waits up to 90 s for all of them to be healthy; `--profile observability` adds the observability container, `--profile tools` the Temporal UI. Running it again starts nothing twice |
| `pnpm stack:status` | every container of the project with its health and its ports |
| `pnpm stack:down` | removes the containers and keeps the volumes; `--wipe` removes the volumes too: every database, file and dashboard of every worktree on the laptop |

| Service | For | On localhost (`DEV_*` in `.env.example`) |
|---|---|---|
| `postgres` | the product database `app` and, from `pnpm env:create`, one `app_<worktree>` each with its login roles; Temporal's `temporal` and `temporal_visibility`. `postgres/init.sql` runs on the first start only: it creates Temporal's databases and installs pgvector in `app` and in `template1`, so every database created later has it. The superuser `postgres` is used only by `env:create` and by Temporal's setup | 5432 |
| `redis` | locks, rate limits, caches, pub/sub; nothing durable and nothing on disk | 6379 |
| `temporal` | durable execution; the `temporal` CLI runs inside it: `docker compose -f deploy/compose.yaml exec temporal temporal operator namespace list` | 7233 |
| `temporal-ui` (`tools`) | inspect workflows | http://localhost:8233 |
| `minio` | files through the S3 API; the root user is `DEV_MINIO_ROOT_USER` with `DEV_MINIO_ROOT_PASSWORD`; buckets come one per worktree from `env:create` | 9000 (S3), 9001 (console) |
| `mailpit` (`dev`) | catches every mail the apps send; read it at http://localhost:8025 or through its API | 1025 (SMTP), 8025 |
| `otel-lgtm` (`observability`) | OTLP in, Grafana out; the apps export only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set | 4318 (OTLP/HTTP), 4317 (OTLP/gRPC), http://localhost:3000 |

- Ports and passwords: the defaults under `deploy` in `.env.example` are also the defaults in `compose.yaml`. To move a port or change a password on a laptop, put that line in `deploy/.env` (git-ignored; Compose reads it on its own) and run `pnpm stack:up` again. The passwords are for this localhost-only stack and nothing else.
- Wipe: `pnpm stack:down --wipe`, then `pnpm stack:up` starts from empty volumes and runs `postgres/init.sql` again.
- Every container is named `whytide-<service>` (the project name, then the service), so `docker logs -f whytide-temporal` and `docker exec whytide-postgres psql -U postgres` work without Compose; `docker compose -f deploy/compose.yaml logs -f <service>` does too. The images, and how to update one: `images.md`.
- Test: `pnpm -F deploy test` runs `tests/stack.test.sh` on a throwaway copy of the stack, on free ports, next to the real one, which it never touches, then `tests/worktree.test.sh` (below) on the real one.

## One slice per worktree

Every worktree gets its own slice of the laptop's stack, never a second stack (docs/rules/delivery.md §2): a database `app_<name>` with its three login roles on the running Postgres, a Temporal namespace `<name>`, a Redis key prefix `<name>:`, a MinIO bucket `<name>` and three free localhost ports for its own api, web and worker, all written to `.env.local` at the worktree's root. `<name>` is the worktree's folder name (`whytide-alpha-p3-020` for that task's worktree), lowercased with anything but letters, digits and hyphens turned into hyphens, or the name given on the command line. Mailpit and the observability container are shared as they are: `.env.local` points `SMTP_HOST`, `SMTP_PORT`, `MAILPIT_API_URL` and `OTEL_EXPORTER_OTLP_ENDPOINT` at them, the endpoint left empty while the observability container is not running, so the apps export nothing. The first two commands of any task, run from the worktree:

| Command | Does |
|---|---|
| `pnpm env:create [name] [--force]` | creates what is missing of the slice and writes `.env.local` from `.env.example`: the variables of the "slice" block of the `deploy` section filled from the running stack, every other variable at the example's default, a value marked `# secret` written empty for the person to fill. Refuses when `.env.local` exists (`--force` writes it again for the same slice, keeps its ports and wipes nothing) and when another worktree on the laptop holds the name (`~/.cache/whytide/slices/<name>` says which) |
| `pnpm env:status` | the slice and whether each part exists; exit code 1 when one is missing |
| `pnpm env:destroy` | drops the database and the slice's roles, deletes the namespace, the keys under the prefix and the bucket with its objects, removes `.env.local` and the lock; run it after the merge, before the worktree is removed |

- The scripts need Docker and pnpm only: `psql`, `redis-cli`, the `temporal` CLI and `curl` run inside the stack's containers through `docker compose exec`. MinIO's image ships no client since `mc` was retired, so the bucket calls are S3 requests signed by the Temporal image's `curl`, over the Compose network.
- The ports and passwords come from the running containers, not from `deploy/.env`, so a fresh worktree without one finds the laptop's stack wherever its ports were moved.
- The database roles (core/packages/db/README.md, docs/adr/0003-roles-from-alpha.md): the superuser creates, when missing, the group roles `app` and `billing_writer` of the first migration and three login roles per slice: `owner_<name>`, who owns `app_<name>` and may create a database (`pnpm db:reset`, Prisma's shadow database), `app_<name>` as a member of `app`, `billing_writer_<name>` as a member of `billing_writer`. Their password is the stack's own, since the stack is localhost-only and its superuser already carries it. `.env.local` gets `DATABASE_URL_OWNER`, `DATABASE_URL` and `DATABASE_URL_BILLING_WRITER` in the `packages/db` block. A database from before the roles is handed to the owner; what the superuser created inside stays the superuser's until `pnpm db:reset` recreates the database. The superuser itself is in no `.env.local`.
- Test: `tests/worktree.test.sh`, the second half of `pnpm -F deploy test`, runs on this laptop's stack: two temporary worktrees of the clone, their slices with their roles, the guards, `--force`, their destruction.

## Production

One server runs Whytide from the same `compose.yaml`, in the profile `production`, which the development stack never starts: Caddy at the edge with automatic HTTPS, the `api`, the `worker` and the `web` from our own images, Postgres, Redis, Temporal and MinIO, and two one-shot services before the api, `postgres-setup` (the database's login roles, `postgres/roles.sh`) and `minio-setup` (the bucket, `minio/bucket.sh`). The api runs the migrations and the modules' start, credits' seeder included, before it listens; the worker and the web start once the api is healthy. Only Caddy publishes ports, and routes as the web's `next.config.ts` does: `/api/auth/*` to the api as it is, the rest of `/api/*` to the api without `/api`, the providers' webhooks (`/v1/<module>/webhooks/*`) to the api, all else to the web. The api and the web are reached on the `edge` network; the api believes `X-Forwarded-For` from Caddy's address only (`TRUST_PROXY`). Every app container runs as a non-root user on a read-only root file system with a writable `/tmp` (the worker also a cache for swc's native addon, which runs from it), without capabilities; the api's and the worker's environment is `deploy/.env` whole, without Postgres's superuser password, and the web has none of it.

### Install

1. A Linux server on amd64 with Docker Engine and its Compose plugin; your domain's DNS record pointing at it; ports 80 and 443 (TCP, and UDP for HTTP/3) open to the internet.
2. This repository at the release's commit, and its images: `bash deploy/scripts/images-build.sh` (also `pnpm images:build`) builds `localhost/whytide/api:<commit>`, `…/worker:<commit>` and `…/web:<commit>` and prints the `IMAGE_TAG`; `IMAGE_REGISTRY` and `--push` put them in a registry for another machine to pull.
3. `cp deploy/.env.production.example deploy/.env`, `chmod 600 deploy/.env`, and fill it: every line marked `# secret`, between its quotes (`openssl rand -base64 32` for `APP_MASTER_KEY`, `openssl rand -hex 32` for `AUTH_SECRET`, `HASH_SALT` and the passwords), the three database URLs with their roles, your domain in `APP_DOMAIN`, `AUTH_BASE_URL`, `APP_PUBLIC_ORIGIN` and `API_PUBLIC_URL`, your mail relay, the providers' keys, and `IMAGE_TAG`.
4. `pnpm deploy:check`, or, from the repository root without Node on the server, `docker run --rm --network none --user "$(id -u)" -v "$PWD/deploy:/deploy:ro" -w /deploy localhost/whytide/api:<tag> node scripts/deploy-check.ts`: it reads the file as Compose does, and refuses a fake adapter, `APP_ENV` other than `production`, a missing or malformed `APP_MASTER_KEY`, `AUTH_SECRET` or `HASH_SALT`, an `APP_MASTER_KEY_PREVIOUS` malformed or the same key, an `http:` `AUTH_BASE_URL`, Caddy's internal authority, the egress allow list, and a development default left in place.
5. `cd deploy && docker compose up -d --wait`: Caddy gets its certificate from Let's Encrypt at its first start. `https://<domain>/api/health` answers 200.
6. The LinkedIn webhooks, once: Unipile's three sources registered against `UNIPILE_NOTIFY_URL`, `https://<domain>/v1/linkedin/webhooks/unipile`, with the header `Unipile-Auth` set to `UNIPILE_WEBHOOK_SECRET` ([docs/runbook.md](docs/runbook.md) "LinkedIn webhooks"). Sending stays closed until the runbook's "Turning sending on".
7. The first invite: `docker compose exec api node ../../modules/identity/dist/cli/invite.js <email>` (core/modules/identity/README.md "The invite command"). An empty database has no workspace to invite to yet: the first organization is alpha-p3-040's. More tenants, for testing: `…/cli/tenant-create.js` and `…/cli/workspace-create.js` in the same way (core/modules/identity/README.md "The tenant commands").

### Backups, upgrades, rollback

[docs/runbook.md](docs/runbook.md): `backup.sh <target> [--keep <n>]` (the three databases and MinIO's folder, the newest seven kept), `restore.sh <backup>` into a fresh stack, which closes sending through linkedin's command before the worker starts, an upgrade and a rollback by image tag, and what to do when a service is down.

### The operator's commands

On the server, from `deploy/`, in the api's container, whose image has no pnpm; [docs/runbook.md](docs/runbook.md) says when to run each, from "LinkedIn webhooks" to "The weekly safety review":

- `docker compose exec api node ../../modules/linkedin/dist/cli/control.js <subcommand>`: linkedin's switches, `status`, then `sending open|close`, `stop|start --platform`, `pause|unpause --workspace <id or slug> [--account <sac_id>]` and `breaker reopen`, each change with `--operator <name>` (core/modules/linkedin/README.md "The control command").
- `docker compose exec api node ../../modules/campaigns/dist/cli/report.js [--workspace <id or slug>] [--since <YYYY-MM-DD>]`: campaigns' report of beta's "Done when", its three zeros first (core/modules/campaigns/README.md "Commands").

### Images

`Dockerfile` builds the three images, one target each, from a build stage that installs the lockfile's packages (pnpm itself checked against the lockfile's integrity) and then, with no network, builds the modules and the hosts one at a time. The api and the worker share a runtime stage with production dependencies only and the schema engine Prisma's migrations need, pinned in `images.md`; the web is Next.js's standalone output, built with `NEXT_PUBLIC_API_URL=http://api:3001`, the api on the Compose network, so one web image serves every domain (a build argument changes it). Each is owned by root and run as `node`. The base images are pinned by digest in `images.md`. The pipeline's hand-triggered job `images:build` is to run `scripts/images-build.sh --push`; it is proposed, not added.

### Tests

- `pnpm -F deploy smoke` runs `tests/production.test.ts`, the pipeline's whole `smoke` step (tools/ci/README.md): the images built, the project `whytide-prodtest` up from the production example with its secrets filled and Caddy's internal authority (`CADDY_INTERNAL_TLS=1`), on free localhost ports beside the laptop's stack; the smoke (health, the migrations, a web page under the web's own policy, a sign-in link from the mail port's fake followed through Caddy as the confirm page does, a GET then a POST), the containers (non-root, read-only, on the pinned bases, the master keys loaded, the schema engine offline), the webhook path (linkedin's route refuses the test's call, and a body over 64 KiB gets the api's 413) and the closed admin endpoint, and the backup drill, which first runs qualification's tick through its schedule: its first read of the fixture's ICP makes it, the last write the worker's schedules make for the fixture. Then the drill opens sending, in this project only, and gives each table beta's migrations create a row in an end state (`tests/fixtures/beta-tables.sql`); after `restore.sh`, every table is as the backup had it but the platform's switches, which read sending closed, with one control event by the operator `restore`. Then the project is removed with its volumes. `PRODTEST_KEEP=1` leaves it running.
- `pnpm -F deploy test` starts with `tests/deploy-check.test.ts`, the rules of `deploy:check` and the production example's coverage of `.env.example`.
- `pnpm -F deploy test:safety` runs `tests/safety/`, as `pnpm ci:local test:safety` does: `restore-closes-sending.test.ts` runs `restore.sh` on a fixture backup with a stub of `docker` that records each call, and fails unless the close comes after the restores and before anything can start the worker, and unless a failed close stops the restore before it.

### What zeta adds

The scanners (CodeQL, Semgrep), the SBOM and signed images (docs/17 §10). Kubernetes, Helm, autoscaling, managed databases and a second region are Cloud's.
