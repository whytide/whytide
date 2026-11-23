// What the worker host loads of enrichment (core/apps/worker/docs/workflows.md; README "What starts a
// run"): the tick, global, which starts one batch per workspace with a held lead, and its schedule;
// the workspace's batch and its two steps; a run, its prepare and finish steps, and its source step
// in each activity kind, run once when it calls out (`provider`, `ai`), with the record of a step
// that failed. onWorkerStart keeps the host's logger and loads the sources, warning once per list
// of the names it leaves out. Inputs and results carry ids, source names, field names and codes.
// The email lookup (gamma-en-080): its prepare, its find step in each activity kind, a verifier's
// turn, the record of a step that failed, its settle; every outside step once.

import { heartbeat } from "@temporalio/activity";
import { leadsHeldForEnrichment } from "@whytide/contacts";
import type { TenantClient } from "@whytide/db";
import {
  type ActivityContext,
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineSchedules,
  defineWorkflows,
  globalWorkflowInput,
  type Logger,
  workflowInput,
} from "@whytide/platform";
import { z } from "zod";
import { ACTIVITY_FAILED, CODE, MINUTE_MS } from "../domain/constants.ts";
import { useLog } from "../domain/log.ts";
import { findCandidates } from "../domain/lookup/find.ts";
import { prepareLookup } from "../domain/lookup/prepare.ts";
import { recordSteps } from "../domain/lookup/request.ts";
import { settleLookupRun } from "../domain/lookup/settle.ts";
import { loadEmail } from "../domain/lookup/sources.ts";
import { verifierOpen, verifyCandidate } from "../domain/lookup/verify.ts";
import { finishRun, openNewLeadRun, prepareRun, recordTried } from "../domain/runs.ts";
import { loadSources, warnLeftOut } from "../domain/sources/index.ts";
import { askSource } from "../domain/step.ts";
import { startBatches } from "../domain/tick.ts";
import { settings } from "../settings.ts";

type Context = ActivityContext<TenantClient>;
const id = z.string().min(1).max(64);
/** A source as a plan names it: `company-data/<adapter>`, `email-finder/<adapter>`, a module source's name. */
const sourceName = z.string().regex(/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/);
const runInput = workflowInput.extend({ runId: id });
const sourceInput = runInput.extend({ source: sourceName });
const lookupInput = workflowInput.extend({ requestId: id });
const findInput = lookupInput.extend({ source: sourceName });
/** A candidate's number; 0, a re-verification's contact point. */
const candidateNumber = z.number().int().min(0).max(1000);
const lookupEnd = z.discriminatedUnion("end", [
  z.strictObject({ end: z.enum(["valid", "catch_all", "not_verified"]), n: candidateNumber }),
  z.strictObject({ end: z.enum(["no_verifier", "exhausted"]) }),
  z.strictObject({ end: z.literal("failed"), code: z.string().max(200) }),
]);

export const workflows = defineWorkflows({
  enrichment_tick: { input: globalWorkflowInput, taskQueue: DEFAULT_TASK_QUEUE, scope: "global" },
  enrichment_batch: { input: workflowInput, taskQueue: DEFAULT_TASK_QUEUE },
  enrichment_run: { input: runInput, taskQueue: DEFAULT_TASK_QUEUE },
  enrichment_lookup: { input: lookupInput, taskQueue: DEFAULT_TASK_QUEUE },
});

/** The source step in its kind's activity: the workflow picks the one the plan names. */
const ask = (input: z.output<typeof sourceInput>, context: Context) => askSource(context, input);
/** An activity's context as the lookup's steps take it: the workspace and its runs. */
const lookupRuns = (context: Context) => ({
  workspaceId: context.workspaceId,
  tenant: <T>(fn: () => Promise<T>) => context.tenant(fn),
});
/** The email source step in its kind's activity. */
const find = (input: z.output<typeof findInput>, context: Context) =>
  findCandidates(lookupRuns(context), input);

export const activities = {
  /** Lists the workspaces and starts the batch of each with a held lead, unless one runs. */
  enrichment_start_batches: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: startBatches,
  }),
  /** The workspace's held leads, oldest first, ENRICHMENT_BATCH_SIZE at most. */
  enrichment_held_leads: defineActivity({
    kind: "db",
    input: workflowInput,
    run: (_input, context: Context) =>
      context.tenant(() => leadsHeldForEnrichment({ limit: settings.ENRICHMENT_BATCH_SIZE })),
  }),
  /** The lead's new_lead run, or none when its key has one: its hold is released then. */
  enrichment_open_run: defineActivity({
    kind: "db",
    input: workflowInput.extend({ personId: id }),
    run: ({ personId }, context: Context) => context.tenant(() => openNewLeadRun(personId)),
  }),
  /** The run `running`, what it wants, why it skips the company: the plan. */
  enrichment_prepare: defineActivity({
    kind: "db",
    input: runInput,
    run: async ({ runId }, context: Context) => {
      const { sources } = await loadSources();
      return context.tenant(() => prepareRun(runId, sources));
    },
  }),
  /** A `provider` source, once: a failure goes to the next source, never to a retry. */
  enrichment_source: defineActivity({
    kind: "provider",
    attempts: 1,
    input: sourceInput,
    run: ask,
  }),
  /** An `ai` source, once, with a heartbeat for each page it reads (the website). */
  enrichment_source_ai: defineActivity({
    kind: "ai",
    attempts: 1,
    input: sourceInput,
    run: (input, context: Context) =>
      askSource({ tenant: (fn) => context.tenant(fn), beat: () => heartbeat() }, input),
  }),
  /** A `db` source. */
  enrichment_source_db: defineActivity({ kind: "db", input: sourceInput, run: ask }),
  /** A source step that failed whatever the reason, recorded `failed` with its code. */
  enrichment_source_failed: defineActivity({
    kind: "db",
    input: sourceInput.extend({ code: z.string().max(200) }),
    run: ({ runId, source, code }, context: Context) => {
      const kept = CODE.test(code) ? code : ACTIVITY_FAILED;
      const entry = { source, outcome: "failed" as const, code: kept, filled: [], ms: 0 };
      return context.tenant(() => recordTried(runId, entry));
    },
  }),
  /** The run done, or failed when its own steps failed; the lead's hold released. */
  enrichment_finish: defineActivity({
    kind: "db",
    input: runInput.extend({ failed: z.literal(true).optional() }),
    run: ({ runId, failed }, context: Context) =>
      context.tenant(() => finishRun(runId, failed === true)),
  }),
  /** An email lookup's free ends, its credits reserved, its plan (gamma-en-080). */
  enrichment_lookup_prepare: defineActivity({
    kind: "db",
    input: lookupInput,
    run: async ({ requestId }, context: Context) => {
      const loaded = await loadEmail();
      // source_usage is global: read outside the run, before any credit or finder.
      const open = await verifierOpen(loaded.verifiers);
      return context.tenant(() => prepareLookup(requestId, loaded, open));
    },
  }),
  /** A `provider` email source, once: a failure goes to the next source, never to a retry. */
  enrichment_find: defineActivity({ kind: "provider", attempts: 1, input: findInput, run: find }),
  /** An `ai` email source, once. */
  enrichment_find_ai: defineActivity({ kind: "ai", attempts: 1, input: findInput, run: find }),
  /** A `db` email source, once. */
  enrichment_find_db: defineActivity({ kind: "db", attempts: 1, input: findInput, run: find }),
  /** One verifier's turn on one candidate, once: a failure passes it to the next verifier. */
  enrichment_verify: defineActivity({
    kind: "provider",
    attempts: 1,
    input: lookupInput.extend({ n: candidateNumber, verifier: sourceName }),
    run: (input, context: Context) => verifyCandidate(lookupRuns(context), input),
  }),
  /** A find or verify step that failed whatever the reason, recorded `failed` with its code. */
  enrichment_lookup_failed: defineActivity({
    kind: "db",
    input: lookupInput.extend({
      source: sourceName,
      step: z.enum(["find", "verify"]),
      code: z.string().max(200),
    }),
    run: async ({ requestId, source, step, code }, context: Context) => {
      const entry = {
        source,
        step,
        outcome: "failed",
        code: CODE.test(code) ? code : ACTIVITY_FAILED,
      };
      const once = step === "find" ? { source, step } : undefined;
      await context.tenant(() => recordSteps(requestId, [{ ...entry, ms: 0 }], once));
    },
  }),
  /** The lookup's end written: the rows, the credits, the event; its files deleted. */
  enrichment_lookup_settle: defineActivity({
    kind: "db",
    input: lookupInput.extend({ ended: lookupEnd }),
    run: ({ requestId, ended }, context: Context) =>
      settleLookupRun(lookupRuns(context), { requestId, ended }),
  }),
};

/** Every ENRICHMENT_TICK_MINUTES; Temporal's default overlap policy skips a tick while one runs. */
export const schedules = defineSchedules([
  {
    id: "tick",
    workflow: "enrichment_tick",
    spec: { intervals: [{ every: settings.ENRICHMENT_TICK_MINUTES * MINUTE_MS }] },
    input: {},
  },
]);

/** Before the worker polls: the host's logger, and the sources loaded, the names left out warned. */
export async function onWorkerStart(context: { readonly log: Logger }): Promise<void> {
  useLog(context.log);
  warnLeftOut(context.log, (await loadSources()).leftOut);
  warnLeftOut(context.log, (await loadEmail()).leftOut);
}
