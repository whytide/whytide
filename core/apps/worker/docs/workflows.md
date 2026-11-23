# Workflows, activities and schedules in a module

Temporal owns the durable part, an activity does the work (docs/architecture.md §8). Workflows orchestrate and carry ids only; activities are idempotent, since Temporal retries them.

## Declaring

The worker loads both files from the module's build, `dist/`, which `pnpm -F worker build` makes (README "Modules").

`workflows/index.ts` (Node side; add `@temporalio/workflow` to the module's dependencies for `workflows.ts`):

```ts
import type { TenantClient } from "@whytide/db";
import { type ActivityContext, DEFAULT_TASK_QUEUE, defineActivity, defineSchedules, defineWorkflows, workflowInput } from "@whytide/platform";
import { z } from "zod";

const runInput = workflowInput.extend({ runId: z.string() });
export const workflows = defineWorkflows({ signals_run: { input: runInput, taskQueue: DEFAULT_TASK_QUEUE } });
export const activities = {
  signals_load: defineActivity({
    kind: "db",
    input: runInput,
    run: (input, context: ActivityContext<TenantClient>) => context.tenant((tx) => tx.signalRun.findUnique({ where: { id: input.runId } })),
  }),
};
export const schedules = defineSchedules([{ id: "nightly", workflow: "signals_run", spec: { cronExpressions: ["0 3 * * *"] }, input: { workspaceId: "…", runId: "…" } }]);
```

`workflows/workflows.ts` (Temporal's sandbox: import types only from the rest of the module):

```ts
import { proxyActivities } from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import type { activities } from "./index.ts";

const { signals_load } = proxyActivities<ActivityFunctions<typeof activities>>({ startToCloseTimeout: "1 minute" });
export async function signals_run(input: { workspaceId: string; runId: string }) {
  await signals_load(input);
}
```

- A name starts with the module's: `<module>_…`, the workflow's being its exported function's.
- Every input extends `workflowInput` (`{ workspaceId }`) and carries ids only: the lint rule `workflow-input-ids-only` refuses a field of the PII registry or a `/// pii` column.
- `context.tenant(fn)` is one tenant run: one per database step. `callAgent` (from `@whytide/ai`) and a port's call run outside it, since a run holds a connection for 5 seconds at most and a nested one is `nested_run`. `callAgent` has no abort signal: a cancelled activity does not stop its model call.
- A schedule's id in Temporal is `<module>.<id>`; its input is read by its workflow's schema at start.
- Work for no workspace declares `scope: "global"` on its workflow and its activities, with an input that extends `globalWorkflowInput` (`{}`); the start refuses a global one with `workspaceId` and a workspace one without it (`worker_module_invalid`, `details.field` `workflows.<name>` or `activities.<name>`). A global activity's `run(input, { attempt })` has no tenant run: it reads the global tables in `withoutTenant("<module>.<reason>")` with db's `globalClient`, or starts one workflow per workspace. credits' `credits_period` is one.
- A workflow a user asks for starts from the module's subscriber, never from a route: `startWorkflow({ workflow, input, workflowId })`, the id built from ids, `<module>.<purpose>:<workspaceId>:<id>` (README "Outbox").

## Retries

Leave `retry` unset in `proxyActivities`: Temporal's default backoff (1 s, doubling, at most 100 s) applies, and the worker ends the attempts by the activity's `kind` (the platform's `ACTIVITY_ATTEMPTS`): `provider` 5, `ai` 3, `db` 3. A timeout counts: the attempt the server starts past the bound fails `activity_attempts_exhausted` before it runs. These codes are never retried: `llm_invalid_key`, `llm_input_invalid`, `ai_input_invalid`, `ai_budget_exceeded`, `cost_price_missing` (it would pay the model again), and the worker's `activity_input_invalid`, `activity_attempts_exhausted` and `activity_not_in_workflow`. A failure whose `details.retryAfterSec` is a positive number (a provider's rate limit, `linkedin_rate_limited`) waits that long before its next attempt, 15 minutes at most, in place of the backoff. An `ai_failed` result of `callAgent` is a value to handle, not an error. A failure carries its code only.

An activity narrows its kind's retries where it is defined:

```ts
import { appMailPort } from "@whytide/providers";

inbox_mail_reply: defineActivity({
  kind: "provider",
  notRetried: [appMailPort.errors.mail_rejected, appMailPort.codes.input],
  input: mailInput,
  run: (input, context) => mailReply(context, input.messageId),
}),
```

- `attempts`: its own bound, a whole number from 1 to its kind's: `attempts: 1` for a send whose retry would need a check first.
- `notRetried`: its codes that are never retried, beside the ones above: `mail_rejected` and `mail_input_invalid` for a mail, `mailbox_token_revoked` for a mailbox call. Each is a registered code: import it from where it is declared (a port, the module's `errors.ts`), which registers it before `defineActivity` runs.

`defineActivity` refuses an `attempts` off that range, or a `notRetried` entry that is no registered code, with `activity_definition_invalid` (500): a bad definition fails when its module loads. A not-retried code ends the activity at once, with a failure that carries the code only. Campaigns' own caps (`SEND_ATTEMPTS`, `PROFILE_READ_ATTEMPTS`) work as before.

The final failure, the attempt the worker does not retry because its attempts are spent or its code is never retried, raises one alert to the team channel, `activity:<activity>:<code>`, with the activity's name and the code only ([README](../README.md) "Alerts"); an attempt that will be retried raises none.

## Long loops

A workflow that walks every workspace, account or due row pages its work: at most a page of ids per activity, and `continueAsNew` with its cursor once Temporal suggests it (`workflowInfo().continueAsNewSuggested`, at about 4,000 events or 4 MB of history, Temporal's defaults), or after a fixed number of pages, a constant in the module's `workflows/constants.ts`. The call stays in `workflows.ts`, through `@temporalio/workflow`; the platform gives the sandbox no helper.

```ts
import { continueAsNew, proxyActivities, workflowInfo } from "@temporalio/workflow";
import { SWEEP_PAGES } from "./constants.ts";

export async function example_sweep(input: { afterId?: string }) {
  let afterId = input.afterId;
  for (let page = 0; page < SWEEP_PAGES; page++) {
    const { lastId } = await example_sweep_page({ afterId }); // one page of ids, at most
    if (lastId === undefined) return;
    afterId = lastId;
    if (workflowInfo().continueAsNewSuggested) break;
  }
  await continueAsNew<typeof example_sweep>({ afterId });
}
```

The worker reports every run whose history grew that long: its interceptor (`src/workflow-interceptors.ts`) tells the host once per run, and the host counts it in `worker.workflow.history_long`, by workflow, and logs one `warn` line, `worker: a workflow's history is long`, with the workflow's type and id only. A workflow already running that starts to continue as new changes its commands: gate the change with `patched()` and record a new history beside the old one.

## Recording a history, replay

Run the workflow on the slice's stack, then `pnpm -F worker history:record <workflowId>` writes `core/modules/<module>/workflows/__histories__/<workflowId>.json`. `pnpm -F worker test:replay` replays every such file against the current code: a change that would break a running workflow fails there. Give the clients an `identity` so that no hostname enters a history. The harness, `core/apps/worker/testing/`, runs workflows on the slice's Temporal with activity overrides; a module's own tests cannot import it, since the rule `module-boundaries` keeps modules off the hosts.
