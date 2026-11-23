# Runbook: production

For the one-server install of [../README.md](../README.md) "Production". Every command runs in `deploy/` on the server, as a user who may run Docker.

The operator's LinkedIn commands run in the api's container, whose image has no pnpm: `docker compose exec api node ../../modules/linkedin/dist/cli/control.js …` ([linkedin's README](../../core/modules/linkedin/README.md#the-control-command) "The control command") and `docker compose exec api node ../../modules/campaigns/dist/cli/report.js …` ([campaigns' README](../../core/modules/campaigns/README.md#commands) "Commands"), which hold their options. Every change names you with `--operator <name>` (lowercase letters, digits, `.`, `_` and `-`), which its control event records. The report's `--since` takes a day, `YYYY-MM-DD`, from its midnight UTC. `-e LOG_LEVEL=warn` after `exec` hides the platform's JSON info lines.

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
2. `./restore.sh /var/backups/whytide/<UTC time>`: Postgres alone, `postgres-setup`, the three databases with pg_restore, MinIO's folder; then the api alone with what it depends on, which applies the migrations, and in it `node ../../modules/linkedin/dist/cli/control.js sending close --operator restore`, which prints `restore: sending closed` (`restore: unchanged: sending closed` when the backup held sending closed); only then the worker, the web and Caddy, waiting for health. A backup can hold sending open, and it lacks what was sent after it, so no worker runs before the close. A close that fails stops the restore with exit 1 before the worker starts: read `docker compose logs api`, fix the cause, run `docker compose exec api node ../../modules/linkedin/dist/cli/control.js sending close --operator <name>` until it prints `sending closed`, then `docker compose up -d --wait`.
3. `https://<domain>/api/health` answers 200, and a tester signs in.

Sending stays closed. No command reconciles a restored database with LinkedIn, so before sending reopens:

4. The never-contact entries and the opt-outs added since the backup's time are entered again on the never-contact list (`/w/<workspace>/never-contact`), from the testers' notes and the reply mails since then.
5. Each account is reconciled by hand: every person LinkedIn shows as invited, messaged or replying since the backup's time, whose step or reply the app does not show (the lead's Sequence panel, the inbox), goes on the never-contact list, so that nothing reaches them twice. Their sequences end there.
6. "Turning sending on" runs again, from its first step.

The drill, steps 1 to 3 on a fixture, runs in `tests/production.test.ts` and takes under two minutes on a laptop: it opens sending before the backup and finds it closed after the restore, with beta's tables back. Practise it on a copy every quarter.

## Upgrade

1. `./backup.sh /var/backups/whytide` first.
2. The new release's images (`bash scripts/images-build.sh` at its commit, or a pull), and its tag in `IMAGE_TAG` in `.env`; run `pnpm deploy:check` when the release changed `.env.production.example`.
3. `docker compose up -d --wait`: the api applies the new migrations before it listens; the worker and the web restart after it.

A release that moves Prisma needs a new pin of the schema engine (`images.md` "Prisma's schema engine"): the image build fails until it has one.

## Rollback

The previous tag in `IMAGE_TAG`, then `docker compose up -d --wait`, when the release added no migration (`core/packages/db/prisma/migrations/`). Migrations only go forward: after one, restore the backup made before the upgrade, then start the previous tag.

## Secrets

A new password or key goes in `.env`, then `docker compose up -d`: `postgres-setup` sets the roles' passwords again, and the apps restart with the new environment. A new `AUTH_SECRET` signs everyone out. `APP_MASTER_KEY` is never replaced without its rotation (the previous key in `APP_MASTER_KEY_PREVIOUS`, zeta).

## LinkedIn webhooks

Once per Unipile account, at the first install and again after every new `UNIPILE_WEBHOOK_SECRET`, Unipile's three sources are registered: `messaging` (`message_received`), `users` (`new_relation`) and `account_status` (every event). Unipile calls each at `UNIPILE_NOTIFY_URL`, `https://<domain>/v1/linkedin/webhooks/unipile`, which Caddy's `/v1/*/webhooks/*` route passes to the api, with the header `Unipile-Auth` set to `UNIPILE_WEBHOOK_SECRET`.

From the repository root on the server, `pnpm unipile:webhooks <command>` does it from `deploy/.env` (`deploy/scripts/unipile-webhooks.ts`; `--env-file <path>` names another file, and a `.env.local` at the root comes before `deploy/.env`). It reads the file as text, never as shell code, and prints its path, never a value: the key, the two secrets, a webhook's headers and Unipile's answers show neither in the output nor in the history or the process list. A server without Node runs each command in deploy:check's form ([README.md](../README.md) "Install", step 4), with the network on, since it calls Unipile:

```sh
docker run --rm --user "$(id -u)" -v "$PWD/deploy:/deploy:ro" -w /deploy localhost/whytide/api:<tag> node scripts/unipile-webhooks.ts check
```

1. `pnpm unipile:webhooks check`: a line per variable, fine or wrong: all five set, `UNIPILE_BASE_URL` https, both secrets 32 characters or more, `UNIPILE_NOTIFY_URL` https with its path ending in `/v1/linkedin/webhooks/unipile`, and a warning when `PROVIDER_LINKEDIN` is not `unipile`. Then one listing at Unipile, which proves the key, with the `whytide-*` webhooks and their URLs. A wrong value stops it before any call, with exit 1.
2. `pnpm unipile:webhooks register`: removes the webhooks named `whytide-messaging`, `whytide-users` and `whytide-account_status`, never one of another name, creates the three, then lists them. Safe to run again, after a new address or a new secret. A Unipile account registered under alpha deletes its old `account_status` webhook by hand unless it has that name (the adapter's README, [core/packages/providers/linkedin/unipile/README.md](../../core/packages/providers/linkedin/unipile/README.md) "Webhooks", gives the API's calls).
3. `list` shows every webhook's id, name and URL, never its headers; `remove` removes the three and no other. A Unipile error prints its HTTP status and short error type only, with exit 1; a usage error exits 2.

- The body limit is the api's, 64 KiB (413 `payload_too_large`); Caddy sets none.
- A new secret means registering again: the README's "Variables" gives the order.
- Unipile stops the message webhooks while an account is not OK, and gives up on a call after five retries, so the webhook can miss a reply (docs/07 §5.3, planning repository). The sender's read of the chat before each message covers that gap.

## Turning sending on

Sending is closed on a fresh install and after every restore. One command opens it, `docker compose exec api node ../../modules/linkedin/dist/cli/control.js sending open --operator <name>`, and it checks nothing, so this list is the gate; nothing else opens sending. In order:

1. Every task on the "Turning sending on" list of the beta index (planning repository) is merged, and this server runs a release that holds them all.
2. The full pipeline is green on `main` at that release, its `test:safety` step included.
3. The owner has updated the security rules §1, the delivery rules §7 and `AGENTS.md`, which still say that nothing is sent.
4. The webhooks are registered ("LinkedIn webhooks").
5. Each tester's account is connected on the LinkedIn screen (`/w/<workspace>/linkedin`), and its owner has accepted the sending disclosure and confirmed that the account is personal. `LINKEDIN_ALERT_EMAIL` names the operator ("The fleet breaker").
6. `docker compose exec api node ../../modules/linkedin/dist/cli/control.js status` shows `sending=closed stop=off`, and no workspace or account stopped.

Then the reply check, on the owner's accounts alone:

7. Every other workspace is paused: `docker compose exec api node ../../modules/linkedin/dist/cli/control.js pause --workspace <id or slug> --operator <name>` for each one `status` lists but the owner's.
8. `docker compose exec api node ../../modules/linkedin/dist/cli/control.js sending open --operator <name>`.
9. The owner runs one sequence from their sender to their own second LinkedIn account, a lead in their workspace: Approve, then each step in Up next. It takes hours: the first message waits for the acceptance, which can reach the app up to 8 hours late, then 1 to 3 hours more. Once the first message has gone out, the second account replies: the reply must appear in the inbox and hold the follow-up (the lead's Sequence panel shows it replied, no follow-up sent).
10. `docker compose exec api node ../../modules/campaigns/dist/cli/report.js` shows the three zeros, read as "The weekly safety review" says.
11. The other workspaces are unpaused, `docker compose exec api node ../../modules/linkedin/dist/cli/control.js unpause --workspace <id or slug> --operator <name>` each: the instance is open.

A failed check closes sending again at once, `docker compose exec api node ../../modules/linkedin/dist/cli/control.js sending close --operator <name>`, and its cause is found and written down before the list runs again.

## Pause and resume

Each switch holds from the next reservation, within 60 seconds ([linkedin's README](../../core/modules/linkedin/README.md#kill-switches) "Kill switches"):

- The tester's, on the LinkedIn screen: the account's pause, which only its owner lifts, and the workspace's "Stop everything".
- The operator's, with `docker compose exec api node ../../modules/linkedin/dist/cli/control.js status` first and after each change:
  - A workspace, or one of its accounts with `--account <sac_id>`: `docker compose exec api node ../../modules/linkedin/dist/cli/control.js pause --workspace <id or slug> --operator <name>`, lifted by `docker compose exec api node ../../modules/linkedin/dist/cli/control.js unpause --workspace <id or slug> --operator <name>`. The operator's pause takes a tester's over, and the screen cannot lift it; the operator's unpause lifts the operator's only (a tester's answers `paused_by_tester`). Ask the tester before an unpause.
  - Every LinkedIn action on the instance, reads included, for a wave of warnings, a provider incident or a doubt about the accounts: `docker compose exec api node ../../modules/linkedin/dist/cli/control.js stop --platform --operator <name>`, lifted by `docker compose exec api node ../../modules/linkedin/dist/cli/control.js start --platform --operator <name>`.
  - Sends only, reads going on, for a send defect or a broken zero: `docker compose exec api node ../../modules/linkedin/dist/cli/control.js sending close --operator <name>`. Once the cause is written down, sending reopens only through "Turning sending on", from its first step.
- A health pause, after a LinkedIn warning, checkpoint or restriction, is lifted only by the account's owner, with Resume on the account's card once the 72-hour cool-down is over (beta-p6-040's button). The operator never lifts one: no command of theirs does.

## The fleet breaker

A restriction or a checkpoint on any account pauses the connection requests of every account on the instance (`invites_paused`) and mails `LINKEDIN_ALERT_EMAIL`, the operator's address in `.env`; messages, withdrawals and reads go on ([linkedin's README](../../core/modules/linkedin/README.md#health) "Health"). Only the operator reopens:

1. Read the trip: `docker compose exec api node ../../modules/linkedin/dist/cli/control.js status` shows `invites_paused=on reason=<trigger>`, and the mail names the workspace and the account; the health event is read as linkedin's runbook "The fleet breaker has tripped" says. Several accounts warned at once: `docker compose exec api node ../../modules/linkedin/dist/cli/control.js stop --platform --operator <name>` first, and find out why.
2. Read the account's last 14 days: `docker compose exec api node ../../modules/campaigns/dist/cli/report.js --workspace <id or slug> --since <the day 14 days ago>` and the Counts page (`/w/<workspace>/counts`).
3. Write the cause down, for the weekly review.
4. `docker compose exec api node ../../modules/linkedin/dist/cli/control.js breaker reopen --operator <name>`; `status` then shows `invites_paused=off reason=none`. The account that tripped it stays paused ("A sender restriction").

## A sender restriction

When LinkedIn warns or restricts an account (docs/07 §10.2, planning repository):

1. The account is already paused, every action stopped for the 72-hour cool-down, and its owner mailed; the fleet breaker has tripped ("The fleet breaker").
2. The owner follows LinkedIn's on-screen steps, an identity check included when asked, and never misleads LinkedIn.
3. Nobody resumes the account during the cool-down.
4. After LinkedIn reinstates it, its owner resumes it with Resume on the account's card (beta-p6-040's button); its connection-request and message targets restart at half.
5. The operator reviews the account's last 14 days and its acceptance (`acceptance_rate_sender`): `docker compose exec api node ../../modules/campaigns/dist/cli/report.js --workspace <id or slug> --since <the day 14 days ago>`, and the Counts page. The cause goes in the weekly review.

A checkpoint follows the same steps, and the weekly review explains it.

## The weekly safety review

On a fixed day each week, the operator runs `docker compose exec -e LOG_LEVEL=warn api node ../../modules/campaigns/dist/cli/report.js --since <the day 7 days ago>` and posts the review's lines to the shared channel:

- The three zeros read 0: `sends_without_approval`, `actions_against_suppressed` and `duplicate_sends` (exit 0). Read the lines, not only the exit code:
  - `send_step_missing` is not one of the three, so a send that bypassed campaigns still exits 0. Each `missing_step` line is explained: an erased person's send (privacy's log), or a defect, which counts as a broken zero.
  - `duplicate_sends` counts linkedin's `ok` rows, one per step, account and kind, so it cannot see a resend of the same step: a tester's report of a step that reached a person twice counts as a broken zero.
  - Each line's follow-up: [campaigns' runbook](../../core/modules/campaigns/docs/runbook.md#the-report) "The report".
- Each restriction and checkpoint (`health_event:`) is explained.
- Noted: the acceptance rate (`acceptance_rate`, target 0.25), the edit share (`drafts_small_edits`, target 0.5), the senders' spans (`sender_span`) and the decision days (`decision_days`).
- A broken zero: `docker compose exec api node ../../modules/linkedin/dist/cli/control.js sending close --operator <name>` at once; its cause is found and written down, then sending reopens only through "Turning sending on", from its first step.

Bounces and complaints are email's, from gamma.
