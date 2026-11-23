# @whytide/worker

The Temporal host: it registers the modules' workflows, activities and schedules from a generated list, runs the agents inside activities, delivers the outbox and answers `GET /health` (docs/architecture.md §3, §8). It holds no feature code. How a module declares its workflows: [docs/workflows.md](docs/workflows.md).

## Commands

| | |
|---|---|
| `pnpm -F worker dev` | builds once, then `node --watch src/main.ts` |
| `pnpm -F worker build` | the generated files (db's, providers', ai's, signals' kinds and the module list), every module's build (`modules:build`), then `tsc -b` |
| `pnpm -F worker start` | `node src/main.ts`: the worker runs its TypeScript sources and the modules' builds |
| `pnpm -F worker test` | builds, then `node --test tests/*.test.ts` on the slice's Temporal and database |
| `pnpm -F worker test:replay` | replays every `core/modules/*/workflows/__histories__/*.json` against the current code |
| `pnpm -F worker test:safety` | builds, then `node --test "tests/safety/*.test.ts"`, the host's send-path safety cases (`tools/ci/README.md`), which `test` never runs: `tests/safety/stop-on-reply.test.ts`, a reply through linkedin's receiver holding the person's steps (beta-p5-010); `tests/safety/no-double-send.test.ts` and `tests/safety/send-recheck.test.ts`, linkedin's send activities retried and stopped before the call (beta-p1-050) |
| `pnpm -F worker history:record <workflowId> [file]` | saves a workflow's history from the slice's Temporal |
| `pnpm -F worker grounding-sample` | the root's `pnpm grounding-sample`: builds, then `scripts/grounding-sample.ts` loads every module's build, so that each defines its source, and draws a workspace's weekly grounding sample or records its reading ([@whytide/ai's README](../../packages/ai/README.md#the-grounding-sample)); `tests/grounding-sample.test.ts` tests its arguments and lines |
| `pnpm -F worker smoke` | runs `worker_smoke`, a no-op workflow, on the stack's Temporal: exits 0 once a running worker answers |
| `pnpm -F worker modules:generate` | writes `src/modules.generated.ts` and `src/workflows.generated.ts` (git-ignored) |
| `pnpm -F worker modules:build` | `tsc -b` of every module, into its `dist/` |

## Start

`main.ts` loads `.env.local`, starts telemetry, then `start()`:
1. loads the modules (below), the agent task registry, checks every task's price (`COST_PRICES_JSON`) and makes the one Mastra instance, passive, under the advisory lock `whytide.mastra_init`, so that two workers starting on a fresh database do not race Mastra's `CREATE TABLE IF NOT EXISTS`;
2. connects to `TEMPORAL_ADDRESS`, binds the starter of `startWorkflow` (Outbox), the canceller of `cancelWorkflow` and the scheduler of a row's schedule, then runs one worker in `TEMPORAL_NAMESPACE` on the task queue `whytide` (`DEFAULT_TASK_QUEUE`), with the workflow bundle of `src/workflows.generated.ts`: they are bound before the worker polls, because a run that waited on the queue while the host was down is taken at once, and its activity may call them;
3. upserts the schedules, starts the outbox loop and `GET /health`.

`SIGTERM` and `SIGINT` stop it in reverse: health, the outbox loop, the worker once its activities settled, the scheduler, the canceller, the starter (an activity still finishing may call them until then), the connection, Mastra, the database clients. A failed start or a failed worker exits 1. The worker runs no migration: the api does at its start (or `pnpm -F db migrate`). The SDK's runtime has no metrics exporter; its warnings go to pino as `temporal: <message>`.

## Modules

`modules:generate` lists every `core/modules/<name>` (not `_` or `.` folders) with an `events.ts` or a `workflows/index.ts`: a module joins the worker by existing. The worker imports both from the module's build, `dist/`, as the api host does: `@whytide/<name>` resolves there too, so a module that subscribes to another's events, imported from its `index.ts` (which re-exports `events`), and the worker reach one copy of it. `build`, and so `dev`, `test` and `test:replay`, builds every module first; a start without a module's build stops with `worker_module_not_built`, `details.missing` naming the file. `events.ts` registers the module's events and subscribers; `workflows/index.ts` exports `workflows`, `activities` and `schedules`, and may export `onWorkerStart({ log })`, awaited once every module is loaded and before the worker polls (credits binds its client there; a throw stops the start with `worker_module_invalid`, `details.field` `onWorkerStart`), and `workflows/workflows.ts` the workflow functions, bundled from `dist/workflows/workflows.js` for Temporal's sandbox. Names start with the module's (`<module>_…`); a bad export stops the start with `worker_module_invalid` (`details.module`, `details.field`), a name taken twice with `worker_duplicate_registration`.

## Activities and retries

Each activity runs through `src/activities.ts`: its input parsed (`activity_input_invalid`), `context.workflowId` from the activity's info (`activity_not_in_workflow` for one no workflow scheduled), `context.tenant(fn)` for one tenant run per database step as `service:worker`, the log context set, a heartbeat every 20 seconds. A failure reaches Temporal as its code only, never a message. The attempts by kind: `provider` 5, `ai` 3, `db` 3 (the platform's `ACTIVITY_ATTEMPTS`, read in `src/retry.ts`), or fewer, the activity's own `attempts`; an attempt past that bound, which the server starts after a timeout, fails `activity_attempts_exhausted` before it runs. `llm_invalid_key`, `llm_input_invalid`, `ai_input_invalid`, `ai_budget_exceeded`, `cost_price_missing` and the worker's `activity_*` codes are never retried, nor the codes of the activity's own `notRetried` ([docs/workflows.md](docs/workflows.md) "Retries"). A global activity (`scope: "global"`) gets `{ attempt }` only: no tenant run, and a log context of `actor` alone, with no `workspace_id`.

## Schedules

Upserted at every start under `<module>.<id>`: a second start updates the schedule, never adds one. `WORKER_SCHEDULES=off` keeps them paused; the next start with `on` resumes them, a pause made by hand included. A schedule removed from the code stays until deleted by hand. A schedule may name a global workflow, as credits' `credits.period` does, every day at 00:05 UTC, and qualification's `qualification.batch_tick`, every `QUALIFICATION_SCHEDULE_MINUTES`, whose activity starts one batch per workspace. Temporal's default overlap policy, skip, applies to every schedule.

A row's own schedule is a subscriber's (platform README "Workflows"): `src/scheduler.ts` implements `createSchedule`, `pauseSchedule` and `deleteSchedule` with the host's client, bound at start beside the starter. Each instant is a calendar of that second in UTC; the action starts the workflow on the host's task queue under the schedule's id, and `startNow` triggers one run at its creation. A create of an id that exists answers `{ created: false }`; a pause, a resume or a delete of one that is gone `{ found: false }`. `WORKER_SCHEDULES` does not apply to them.

## Outbox

One loop per process: `deliverPending()` again at once while a pass claims rows, else after `OUTBOX_POLL_MS`. Several workers are safe (the store's row locks). There is no `LISTEN`/`pg_notify` wake-up in alpha: an event waits one poll interval at most.

A subscriber starts a workflow with the platform's `startWorkflow` (platform README "Workflows"); `src/starter.ts` implements it with the host's Temporal client, on the host's task queue. It parses the input against the workflow's registration (`workflow_input_invalid`, `details.fields`; `worker_workflow_unknown` for a name no module registers), then starts it with `workflowIdReusePolicy` `REJECT_DUPLICATE` and `workflowIdConflictPolicy` `FAIL`: an id that is running or has run (`WorkflowExecutionAlreadyStartedError`) answers `{ started: false }`. A start with `oneAtATime` sends `ALLOW_DUPLICATE` instead: only a running id answers `{ started: false }`, a closed one runs again (qualification's batch). Any other failure throws, and the outbox retries the event.

`cancelWorkflow({ workflowId })` is `src/canceller.ts`, with the same client: it describes the workflow and cancels it only when it is open, `{ cancelled: true }`. An id no workflow has, or a closed workflow's, answers `{ cancelled: false }`; the check comes first because Temporal takes the cancel of a closed workflow without an error. Any other failure throws.

## Health

`GET /health` on `127.0.0.1:WORKER_HEALTH_PORT` (never another interface: the worker has no inbound port): 200 `{ status: "ok", namespace, task_queue, workflow_count, temporal: "connected", worker: "RUNNING", last_poll_at }`, else 503 with `status: "failing"`. Temporal must answer `DescribeNamespace` within two seconds.

## Testing

`testing/index.ts` runs on the slice's Temporal, never a downloaded test server, so there is no time skipping: keep timers short. `withTestWorkflowEnvironment()` once per test file (a task queue of its own), `runWorkflow(name, input, { activities })`, `replayHistories(workflowsPath, files)`. `tests/host.test.ts` starts the host on the fixture module (`tests/fixtures/module`) and a schema of the slice's database; `tests/replay.test.ts` replays its recorded history; `tests/credits-period.test.ts` runs credits' `credits_period` and its schedule; `tests/credits-alerts.test.ts` credits' `credits_alerts` and its schedule on the app-mail fake, with a second worker whose interceptor (`tests/fixtures/credits-alerts-timeouts.ts`) cuts the mail's start-to-close to 300 ms for the timeout case; `tests/qualification-batch.test.ts` qualification's batch and tick, on the LLM fake, then through the host from discovery's event, and its re-score.

## Configuration

`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `WORKER_HEALTH_PORT` (3002), `WORKER_SCHEDULES` (`on`) and `ALERTS_REPEAT_MINUTES`, in the `apps/worker` block of `deploy/.env.example`.

- `ALERTS_REPEAT_MINUTES` (15): an alert whose key was queued within so many minutes is counted, not sent again ("Alerts", the repeat window); a whole number of 1 or more with no maximum, its default `ALERT_REPEAT` in `src/constants.ts`, a constant until env-settings-b (the owner's request of 2026-11-15). Unset or empty, 15; another value stops the start with `config_invalid` naming it. Read once, as the worker starts: a changed value needs a worker restart (the api reads none of this block). `tests/alerts-repeat.test.ts` sets 60 and tries the values refused. `smoke` and `history:record` refuse a `TEMPORAL_ADDRESS` off this machine (`temporal_address_not_local`).

## Errors

`worker_module_invalid`, `worker_module_not_built`, `worker_duplicate_registration`, `activity_input_invalid`, `activity_attempts_exhausted`, `activity_failed` (a thrown value that is not an `AppError`), `activity_not_in_workflow`, `worker_workflow_unknown`, `workflow_input_invalid`, `temporal_address_not_local`: developer-facing, no message keys.

## Metrics

`src/metrics.ts` (alpha-p10-060; [deploy/docs/observability.md](../../../deploy/docs/observability.md)): `worker.workflow.starts` (workflow, trigger `start` or `schedule`), `worker.workflow.runs` (workflow, outcome `completed`, `failed`, `cancelled` or `continued`) and `worker.workflow.history_long` (workflow: a run whose history Temporal suggests continuing as new, once per run, with one `warn` line of the workflow's type and id, [docs/workflows.md](docs/workflows.md) "Long loops"), from a workflow interceptor (`src/workflow-interceptors.ts`) through a sink that never runs on replay; `worker.activity.failures` (activity, code) from the activity wrapper; `worker.health`, 1 or 0, with the outbox's gauges every 15 seconds. `runWorkflow` and the replay of `testing/` register the same sink, `runWorkflow`'s `log` taking its line.

## Alerts

`src/alerts.ts` (gamma-p7-040) tells the operators in the team channel, through the alerts port (`@whytide/providers`, `PROVIDER_ALERTS`), within a minute, when background work fails for good. No paging, on-call or burn rate; the owners' and the operator's mails stay as they are.

- **What raises one, and its key**: an activity's final failure, the attempt `retries()` does not retry, its attempts spent or its code on `NOT_RETRIED` or the activity's `notRetried` (`src/activities.ts`), key `activity:<activity>:<code>`; a failed workflow run, through the interceptor's sink (`src/workflow-interceptors.ts`, `src/temporal.ts`), `workflow:<type>:<code>`, the code being its ApplicationFailure's type, an activity's or a child's cause's, else the failure's class; an outbox pass that dead-letters events (`src/outbox.ts`), `outbox:dead`, with their count; a module's own alert event, `event:<event name>:<the payload's first id>`.
- **A module's alert events**: `workflows/index.ts` may export `alerts`, a list of its own event names, as linkedin does (`linkedin.invites_paused`, `linkedin.account_paused`). The start reads it with the other exports (`src/modules.ts`) and stops with `worker_module_invalid` (`details.field` `alerts`, `details.event`) on a name no `events.ts` registered or another module's, then subscribes to each, once per process. The handler only queues: no I/O runs inside the delivery's transaction.
- **The text**: `[<APP_ENV>] <kind> <name> <code>`; for an event, its id fields (a key ending in `_id` or `Id` whose value is shaped `<prefix>_<ULID>`) and its numbers, each `key=value`; for the outbox, `count=<n>`; then `×<n>`, the alerts of its key counted since the last one; `ALERT_TEXT_MAX` characters at most. A name or a code that is not one word (`ALERT_TOKEN`) is `unknown`. Never an error's message, a stack, a URL or another payload field: Slack's `<!channel>` and Discord's `@everyone` would ping the whole channel.
- **The repeat window**: an alert whose key was queued within `ALERTS_REPEAT_MINUTES` (15 unset, "Configuration") is counted, not queued; the next one after the window carries the count.
- **The queue**: `raise()` is synchronous and holds `ALERT_QUEUE_MAX` (100) alerts at most, dropping the oldest. A timer loop drains it every `ALERT_DRAIN_MS` (1 s), outside every activity, workflow and transaction: each send in its own span, `worker.alert.send`, `ALERT_SEND_ATTEMPTS` (3) attempts at most, waiting the port's `retryAfterSec` (60 s at most, `ALERT_RETRY_AFTER_MAX_SEC`) or 1 s doubling; `alerts_rejected` and `alerts_input_invalid` are not tried again. Then the alert is dropped with a `warn` line, `worker: an alert was dropped`, and its code. A send is no activity, so an alert never raises another. A stopped or crashed worker loses its queue: the alerts are best effort, the modules' mails the reliable route. The constants are in `src/constants.ts`, the repeat window's default among them.
- **`PROVIDER_ALERTS` empty**, the default: the start logs `worker: team channel off` once, binds nothing, and every alert is dropped silently. `start({ alerts })` picks the adapter in a test.
- **The metric** `worker.alerts`, by `outcome`: `sent`, `repeated`, `dropped` (the queue full) or `failed` (after its attempts).
- **Tests**: `tests/alerts.test.ts`, pure (the text, the keys, the window, the queue, the attempts, on a set clock and the fake), and `tests/alerts-repeat.test.ts`, the window set to 60 minutes; `tests/alerts-worker.test.ts`, on the slice's Temporal and database (the activities, a failed run, a dead letter, linkedin's two events, a failing channel, an unknown event); `tests/host.test.ts`, the fixture module's `alerts` at start. Email's events join with the email phase (gamma-p1-060).
