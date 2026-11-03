# Observability

The api and the worker export OpenTelemetry over OTLP; the `otel-lgtm` container of the `observability` profile receives it and shows it in Grafana, with the dashboards and alert rules of `deploy/observability/` provisioned at every start (architecture §16). Nothing is hosted elsewhere, and no alert notifies anyone: alerts show under Alerting in Grafana.

## Starting the profile

- `pnpm stack:up --profile observability` starts the container (image pinned by digest, `images.md`): Grafana on http://localhost:3000 (`DEV_GRAFANA_PORT`), OTLP/HTTP on 4318 (`DEV_OTEL_PORT`), every port on 127.0.0.1.
- The container mounts `deploy/observability/` of the folder it was started from: start it from the main clone, which outlives the worktrees. From a worktree whose stack another folder started, start the container alone, `docker compose -f deploy/compose.yaml --profile observability up -d --no-deps otel-lgtm`: `stack:up` there would recreate the services whose mounts name the other folder.
- A slice exports once `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` is in its `.env.local` (`pnpm env:create --force` writes it while the container runs). The SDK exports metrics every 60 s; `OTEL_METRIC_EXPORT_INTERVAL` (ms) shortens it.
- Every slice exports into the one Prometheus, and no series names its slice: a dashboard sums the laptop's worktrees.
- Prometheus runs with `created-timestamp-zero-ingestion`, so a counter's first export counts as an increase.
- Stopping it alone: `docker stop whytide-otel-lgtm`; the data stays in the `otel-lgtm` volume.

## Dashboards

In the Grafana folder "Whytide", read-only (edit the JSON, Grafana reloads it within 30 s):

| File | Shows |
|---|---|
| `dashboards/api.json` | requests by route, latency p95, errors by code, rate-limit hits |
| `dashboards/worker.json` | workflow runs by name and outcome, schedule fires, activity failures, worker health, outbox lag, dead letters |
| `dashboards/providers.json` | calls, errors and rate limits per port and adapter |
| `dashboards/ai.json` | AI calls by task and outcome, the `ai_failed` rate, retries, tokens, cost per task |
| `dashboards/credits.json` | credit usages by outcome (reserved, committed, released, expired), reservations refused for insufficient credits |

## Alerts

`alerts.json`, the group `whytide`, evaluated every 10 s; Grafana reads it at its start only, so `docker restart whytide-otel-lgtm` after a change:

| Rule | Fires when |
|---|---|
| Worker health failing | `worker_health` is below 1 for a minute, or no worker reports it |
| Dead letters above zero | an outbox row waits dead-lettered, in any workspace |
| `ai_failed` above ten percent over an hour | more than a tenth of the AI calls not served from the cache ended `ai_failed` |
| Provider error rate above ten percent over fifteen minutes | more than a tenth of the calls to one port's adapter failed |
| Outbox lag above five minutes | the oldest due outbox row has waited longer |

## How to add a metric

1. Declare it in the `metrics.ts` of the host or package that emits it: `defineMetrics({ "<area>.<name>": { kind: "counter", labels: ["outcome"] } }, import.meta.url)` (core/packages/platform/README.md "Metrics"). Labels come from the allow-list: route templates, codes, names, never an id, an email or a URL.
2. Emit it through the recorder `defineMetrics` returns, and in a test of the package.
3. Query it by its Prometheus name: dots become underscores, a counter ends in `_total`, a histogram in seconds in `_seconds_bucket`, `_sum` and `_count`, a gauge in seconds in `_seconds`.
4. Run the package's tests, then `pnpm observability:check`: every query names a declared metric, every declared metric was emitted by a test, and no recorded label value looks like an email, a URL or an id.

The credits dashboard came with alpha-p10-010 and the signals one (runs, candidates, drops by reason, reads against the cap) with alpha-p8-020: each adds its `metrics.ts` and its `dashboards/<module>.json` this way.

## Test

`pnpm -F deploy test:observability`, with the profile running and the worktree's slice: it builds the api and the worker, starts them exporting to the container, checks the dashboards and the rules Grafana holds, runs both smoke tests and waits for data on the api and worker panels, then dead-letters one outbox row of its own and waits for "Dead letters above zero" to fire.
