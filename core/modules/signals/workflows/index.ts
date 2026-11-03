// What the worker host loads of signals (core/apps/worker/docs/workflows.md; README.md "Runs",
// "Processing", "Reduction"): the run workflow and its steps, each in its own tenant run, none around a
// provider's read, which is linkedin's activity, called by name: the kind's reader, and the profile
// read; the evidence reduction, its daily tick and the tick's schedule. Inputs carry ids only. A
// source's schedule is its own, made by events.ts, not one of `schedules`.
import type { TenantClient } from "@whytide/db";
import {
  type ActivityContext,
  createLogger,
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineSchedules,
  defineWorkflows,
  globalWorkflowInput,
  isAppError,
  workflowInput,
} from "@whytide/platform";
import { z } from "zod";
import { PROCESS_CHUNK } from "../domain/process/keys.ts";
import { processCandidates, readProfiles } from "../domain/process/process.ts";
import { ownCompanyName, selectCandidates, writeRequests } from "../domain/process/select.ts";
import { reduceEvidence, startReductions } from "../domain/reduce/reduce.ts";
import {
  deleteRunFiles,
  endRun,
  type RunEnd,
  readPageFile,
  reserveCredits,
  reserveRead,
  settleCredits,
  settleRead,
  stagePage,
  startRun,
} from "../domain/runs.ts";

const id = z.string().min(1).max(64);
/** A run, scheduled (no runId: the workflow makes it) or by hand (the row's). */
export const runInput = workflowInput.extend({ sourceId: id, runId: id.optional() });
const step = workflowInput.extend({ sourceId: id, runId: id });
const count = z.int().min(0);
type Tx = ActivityContext<TenantClient>;
let log: ReturnType<typeof createLogger> | undefined;

export const workflows = defineWorkflows({
  signals_run: { input: runInput, taskQueue: DEFAULT_TASK_QUEUE },
  signals_evidence_reduction: { input: workflowInput, taskQueue: DEFAULT_TASK_QUEUE },
  signals_evidence_reduction_tick: {
    input: globalWorkflowInput,
    taskQueue: DEFAULT_TASK_QUEUE,
    scope: "global",
  },
});

export const activities = {
  /** The run's row, with the id of the workflow that runs it, a schedule's included (fix-run-stop). */
  signals_run_start: defineActivity({
    kind: "db",
    input: step,
    run: (ref, context: Tx) => context.tenant(() => startRun(ref, context.workflowId)),
  }),
  signals_reserve_read: defineActivity({
    kind: "db",
    input: step.extend({
      accountId: id,
      kind: z.enum(["read_engagers", "read_profile"]).default("read_engagers"),
    }),
    run: (input, context: Tx) =>
      context.tenant(() => reserveRead(input, input.accountId, input.kind)),
  }),
  signals_settle_read: defineActivity({
    kind: "db",
    input: step.extend({ reservationId: id, made: z.boolean() }),
    run: (input, context: Tx) => context.tenant(() => settleRead(input.reservationId, input.made)),
  }),
  signals_reserve_credits: defineActivity({
    kind: "db",
    input: step.extend({ attempt: z.int().min(1), quantity: z.int().min(1), billed: count }),
    run: (input, context: Tx) =>
      context.tenant(() => reserveCredits(input, input.attempt, input.quantity, input.billed)),
  }),
  signals_settle_credits: defineActivity({
    kind: "db",
    input: step.extend({ usageId: id, read: count, billed: count }),
    run: ({ usageId, read, billed }, context: Tx) =>
      context.tenant(() => settleCredits(usageId, read, billed)),
  }),
  signals_stage_page: defineActivity({
    kind: "db",
    input: step.extend({
      page: z.int().min(1),
      key: z.string().min(1).max(1024),
      cutAt: z.iso.datetime(),
      read: count,
    }),
    run: async (input, context: Tx) => {
      const file = await readPageFile(input.workspaceId, input.key);
      const page = { number: input.page, key: input.key, cutAt: input.cutAt, read: input.read };
      return context.tenant(() => stagePage(input, page, file));
    },
  }),
  /** The cheap drops; a request file per candidate left; their ids, oldest staged first. */
  signals_select_candidates: defineActivity({
    kind: "db",
    input: step,
    run: async (ref, context: Tx) => {
      const ownName = await ownCompanyName(ref.workspaceId);
      const selected = await context.tenant(() => selectCandidates(ref, ownName));
      await writeRequests(ref.workspaceId, ref.runId, selected);
      return { candidateIds: selected.map((candidate) => candidate.id) };
    },
  }),
  /** A chunk of candidates whose profiles were read, their files read before the run. */
  signals_process_candidates: defineActivity({
    kind: "db",
    input: step.extend({ candidateIds: z.array(id).min(1).max(PROCESS_CHUNK) }),
    run: async (input, context: Tx) => {
      const { workspaceId, runId, candidateIds } = input;
      const profiles = await readProfiles(workspaceId, runId, candidateIds);
      const ownName = await ownCompanyName(workspaceId);
      return context.tenant(() => processCandidates(input, candidateIds, profiles, ownName));
    },
  }),
  signals_run_end: defineActivity({
    kind: "db",
    input: step.extend({
      status: z.enum(["done", "failed", "cancelled"]),
      code: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,63}$/)
        .optional(),
      newest: z.iso.datetime().optional(),
      usageId: id.optional(),
      read: count,
      billed: count,
    }),
    run: async ({ status, code, newest, usageId, read, billed, ...ref }, context: Tx) => {
      // Outside the run and before it, so a retry deletes what is left; raw/'s 72 hours catch a miss.
      await deleteRunFiles(ref.workspaceId, ref.runId).catch((error: unknown) => {
        const fields = { run_id: ref.runId, code: isAppError(error) ? error.code : "unknown" };
        (log ??= createLogger()).warn(fields, "signals: the run's files stay until raw/ expires");
      });
      const end: RunEnd =
        status === "failed"
          ? { status, code: code ?? "activity_failed" }
          : status === "done"
            ? { status, newest }
            : { status };
      return context.tenant(() => endRun(ref, end, { usageId, read, billed }));
    },
  }),
  /** The tick's: every workspace's reduction started, unless one runs; the counts. */
  signals_start_reductions: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: startReductions,
  }),
  /** The workspace's evidence past its kind's lookback reduced, a batch per run; the count logged. */
  signals_reduce_evidence: defineActivity({
    kind: "db",
    input: workflowInput,
    run: async (_input, context: Tx) => {
      const reduced = await reduceEvidence(context.tenant);
      (log ??= createLogger()).info({ reduced_count: reduced }, "signals: evidence reduced");
      return { reduced };
    },
  }),
};

/** Daily at 03:00 UTC; Temporal's default overlap policy skips a tick while one runs. */
const daily = { cronExpressions: ["0 3 * * *"], timezone: "UTC" };
export const schedules = defineSchedules([
  {
    id: "evidence_reduction",
    workflow: "signals_evidence_reduction_tick",
    spec: daily,
    input: {},
  },
]);
