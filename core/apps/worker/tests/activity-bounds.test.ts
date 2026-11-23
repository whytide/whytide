// Each activity's own retry bound and codes, and the long-history report (gamma-p0-080;
// docs/workflows.md "Retries" and "Long loops"), end to end on the slice's Temporal: test activities
// through the host's wrapper (src/activities.ts) and the host's interceptor and sink, with `retry`
// unset in proxyActivities, as every module leaves it, so Temporal's backoff runs between attempts. A
// mail whose notRetried holds mail_rejected runs once on it, and up to its kind's bound on another
// code; an own bound of 1 runs once on any failure, of 3 for a provider at most 3 times; an activity
// that times out on every attempt ends after its kind's bound with activity_attempts_exhausted, the
// attempt past it refused before it runs. A workflow whose history Temporal marks as too long is
// reported once, counted and logged with its type and id only. No database: these activities use none.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@temporalio/activity";
import {
  ACTIVITY_ATTEMPTS,
  type ActivityDefinition,
  AppError,
  collectLogs,
  createLogger,
  defineActivity,
  recordedMetrics,
  workflowInput,
} from "@whytide/platform";
import { appMailPort } from "@whytide/providers";
import { z } from "zod";
import { hostActivity } from "../src/activities.ts";
import { runWorkflow, withTestWorkflowEnvironment } from "../testing/index.ts";

withTestWorkflowEnvironment({
  workflowsPath: join(import.meta.dirname, "fixtures", "activity-bounds-workflows.ts"),
});
const logs = collectLogs();
const log = createLogger({ destination: logs.destination });
const WORKSPACE_ID = "ws_bounds";
/** The start-to-close of an attempt that ends at once. */
const CALL_MS = 60_000;
/** The start-to-close of an attempt that hangs: short, as Temporal's backoff comes between attempts. */
const HANG_MS = 500;
/** How long a hanging attempt sleeps: past its start-to-close, until the worker cancels it. */
const HANG_FOR_MS = 30_000;
/**
 * bounds_history's batches: so many local activities each, at most so many batches (about 8,000
 * events, past Temporal's default hint at 4,096), and so many past the hint.
 */
const GROWTH = { marks: 400, most: 20, after: 2 };
const LONG = "worker: a workflow's history is long";
/** The keys pino writes on every line. */
const PINO_KEYS = new Set(["level", "time", "pid", "hostname", "msg"]);
const NAME = "bounds_activity";

/** `definition` as activity NAME, through the host's wrapper, in bounds_probe: the code it failed with. */
function probe(definition: ActivityDefinition, input: object = {}, startToCloseMs = CALL_MS) {
  const activities = { [NAME]: hostActivity(NAME, definition, { log }) };
  const request = {
    activity: NAME,
    input: { workspaceId: WORKSPACE_ID, ...input },
    startToCloseMs,
  };
  return runWorkflow<{ code: string | null }>("bounds_probe", request, { activities, log });
}

/** A provider activity failing every attempt with the input's code, or with no AppError; `seen` gets the attempts. */
function failing(seen: number[], own: { attempts?: number; notRetried?: string[] } = {}) {
  return defineActivity({
    kind: "provider",
    input: workflowInput.extend({ code: z.string().optional() }),
    ...own,
    run: async ({ code }, { attempt }) => {
      seen.push(attempt);
      throw code ? new AppError(code) : new Error("an error that is not an AppError");
    },
  });
}

const upTo = (bound: number) => Array.from({ length: bound }, (_, index) => index + 1);

test("a mail whose notRetried holds mail_rejected runs once on it, and up to its kind's bound on another code", async () => {
  const seen: number[] = [];
  const { errors, codes } = appMailPort;
  const mail = failing(seen, { notRetried: [errors.mail_rejected, codes.input] });
  assert.deepEqual(await probe(mail, { code: errors.mail_rejected }), { code: "mail_rejected" });
  assert.deepEqual(seen.splice(0), [1]);
  const unreachable = await probe(mail, { code: errors.mail_unreachable });
  assert.deepEqual(unreachable, { code: "mail_unreachable" });
  assert.deepEqual(seen.splice(0), upTo(ACTIVITY_ATTEMPTS.provider));
});

test("an activity with attempts 1 runs once on any failure; one with attempts 3 and kind provider at most 3 times", async () => {
  const seen: number[] = [];
  const once = failing(seen, { attempts: 1 });
  assert.deepEqual(await probe(once, { code: "mail_unreachable" }), { code: "mail_unreachable" });
  assert.deepEqual(seen.splice(0), [1]);
  assert.deepEqual(await probe(once), { code: "activity_failed" });
  assert.deepEqual(seen.splice(0), [1]);
  const three = failing(seen, { attempts: 3 });
  assert.deepEqual(await probe(three, { code: "mail_unreachable" }), { code: "mail_unreachable" });
  assert.deepEqual(seen.splice(0), [1, 2, 3]);
});

test("an activity that times out on every attempt, with retry unset, ends after its kind's bound with activity_attempts_exhausted", async () => {
  const seen: number[] = [];
  const hangs = defineActivity({
    kind: "db",
    input: workflowInput,
    run: async (_input, { attempt }) => {
      seen.push(attempt);
      await Context.current().sleep(HANG_FOR_MS);
    },
  });
  assert.deepEqual(await probe(hangs, {}, HANG_MS), { code: "activity_attempts_exhausted" });
  assert.deepEqual(seen, upTo(ACTIVITY_ATTEMPTS.db));
});

test("a workflow whose history Temporal marks as too long is counted once, with one warn line of its type and id only", async () => {
  const activities = { bounds_mark: async () => null, bounds_tick: async () => null };
  const run = await runWorkflow<{ workflowId: string; suggested: boolean; historyLength: number }>(
    "bounds_history",
    GROWTH,
    { activities, log },
  );
  assert.ok(run.suggested, `no continue-as-new suggested at ${run.historyLength} events`);
  const counted = recordedMetrics().get("worker.workflow.history_long");
  assert.deepEqual(counted, [{ workflow: "bounds_history" }]);
  const lines = logs.lines().filter(({ msg }) => msg === LONG);
  assert.equal(lines.length, 1);
  const [line = {}] = lines;
  assert.equal(line.level, "warn");
  const fields = Object.entries(line).filter(([key]) => !PINO_KEYS.has(key));
  assert.deepEqual(Object.fromEntries(fields), {
    workflow: "bounds_history",
    workflow_id: run.workflowId,
  });
});
