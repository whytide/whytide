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
2. connects to `TEMPORAL_ADDRESS` and runs one worker in `TEMPORAL_NAMESPACE` on the task queue `whytide` (`DEFAULT_TASK_QUEUE`), with the workflow bundle of `src/workflows.generated.ts`;
3. upserts the schedules, binds the starter of `startWorkflow` and the canceller of `cancelWorkflow` (Outbox), starts the outbox loop and `GET /health`.

`SIGTERM` and `SIGINT` stop it in reverse: health, the outbox loop, the starter, the worker once its activities settled, the connection, Mastra, the database clients. A failed start or a failed worker exits 1. The worker runs no migration: the api does at its start (or `pnpm -F db migrate`). The SDK's runtime has no metrics exporter; its warnings go to pino as `temporal: <message>`.

## Modules

`modules:generate` lists every `core/modules/<name>` (not `_` or `.` folders) with an `events.ts` or a `workflows/index.ts`: a module joins the worker by existing. The worker imports both from the module's build, `dist/`, as the api host does: `@whytide/<name>` resolves there too, so a module that subscribes to another's events, imported from its `index.ts` (which re-exports `events`), and the worker reach one copy of it. `build`, and so `dev`, `test` and `test:replay`, builds every module first; a start without a module's build stops with `worker_module_not_built`, `details.missing` naming the file. `events.ts` registers the module's events and subscribers; `workflows/index.ts` exports `workflows`, `activities` and `schedules`, and may export `onWorkerStart({ log })`, awaited once every module is loaded and before the worker polls (credits binds its client there; a throw stops the start with `worker_module_invalid`, `details.field` `onWorkerStart`), and `workflows/workflows.ts` the workflow functions, bundled from `dist/workflows/workflows.js` for Temporal's sandbox. Names start with the module's (`<module>_…`); a bad export stops the start with `worker_module_invalid` (`details.module`, `details.field`), a name taken twice with `worker_duplicate_registration`.

## Activities and retries

Each activity runs through `src/activities.ts`: its input parsed (`activity_input_invalid`), `context.workflowId` from the activity's info (`activity_not_in_workflow` for one no workflow scheduled), `context.tenant(fn)` for one tenant run per database step as `service:worker`, the log context set, a heartbeat every 20 seconds. A failure reaches Temporal as its code only, never a message. The attempts by kind: `provider` 5, `ai` 3, `db` 3 (`src/retry.ts`); `llm_invalid_key`, `llm_input_invalid`, `ai_input_invalid`, `ai_budget_exceeded` and `cost_price_missing` are never retried. A global activity (`scope: "global"`) gets `{ attempt }` only: no tenant run, and a log context of `actor` alone, with no `workspace_id`.

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

`testing/index.ts` runs on the slice's Temporal, never a downloaded test server, so there is no time skipping: keep timers short. `withTestWorkflowEnvironment()` once per test file (a task queue of its own), `runWorkflow(name, input, { activities })`, `replayHistories(workflowsPath, files)`. `tests/host.test.ts` starts the host on the fixture module (`tests/fixtures/module`) and a schema of the slice's database; `tests/replay.test.ts` replays its recorded history; `tests/credits-period.test.ts` runs credits' `credits_period` and its schedule; `tests/qualification-batch.test.ts` qualification's batch and tick, on the LLM fake, then through the host from discovery's event, and its re-score.

## Configuration

`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `WORKER_HEALTH_PORT` (3002) and `WORKER_SCHEDULES` (`on`), in the `apps/worker` block of `deploy/.env.example`. `smoke` and `history:record` refuse a `TEMPORAL_ADDRESS` off this machine (`temporal_address_not_local`).

## Errors

`worker_module_invalid`, `worker_module_not_built`, `worker_duplicate_registration`, `activity_input_invalid`, `activity_attempts_exhausted`, `activity_failed` (a thrown value that is not an `AppError`), `activity_not_in_workflow`, `worker_workflow_unknown`, `workflow_input_invalid`, `temporal_address_not_local`: developer-facing, no message keys.

## Metrics

`src/metrics.ts` (alpha-p10-060; [deploy/docs/observability.md](../../../deploy/docs/observability.md)): `worker.workflow.starts` (workflow, trigger `start` or `schedule`) and `worker.workflow.runs` (workflow, outcome `completed`, `failed`, `cancelled` or `continued`), from a workflow interceptor (`src/workflow-interceptors.ts`) through a sink that never runs on replay; `worker.activity.failures` (activity, code) from the activity wrapper; `worker.health`, 1 or 0, with the outbox's gauges every 15 seconds. `runWorkflow` and the replay of `testing/` register the same sink.
