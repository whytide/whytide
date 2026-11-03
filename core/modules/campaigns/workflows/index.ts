// What the worker host loads of campaigns (core/apps/worker/docs/workflows.md; README.md "Worker",
// "The queue"): the daily plan's tick, global, which starts one plan per workspace every
// TICK_MINUTES, its schedule, and the workspace's plan, which plans each sender account of its
// scheduled steps in a tenant run of its own; the queue's tick, global, which starts one queue run
// per workspace every TICK_MINUTES, its schedule, and the workspace's queue run, which lists the due
// steps and opens each one's item in a tenant run of its own; and each sender account's sender, which
// the plan starts once it placed a step for today, one at a time per account by
// campaigns.sender:<workspace>:<account>, and its five activities (workflows/sender.ts), with the two
// of the profile read before a connection request (workflows/profile.ts) and the checks of its
// steps left `executing` (beta-p4-040), the plan starting it for those too; the withdrawal job's
// tick, global, daily, which starts one run per workspace that opens its withdrawals in a tenant
// run (workflows/withdraw.ts). Inputs carry ids, codes and instants only; results are ids, codes
// and counts.
import type { TenantClient } from "@whytide/db";
import {
  type ActivityContext,
  createLogger,
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineSchedules,
  defineWorkflows,
  globalWorkflowInput,
  type Logger,
  startWorkflow,
  type WorkflowStart,
  workflowInput,
} from "@whytide/platform";
import { listWorkspaceIds } from "@whytide/tenancy";
import { z } from "zod";
import { now } from "../domain/clock.ts";
import { ID_MAX } from "../domain/constants.ts";
import { placedToday, planAccount, scheduledAccounts } from "../domain/plan/account.ts";
import { dueStepIds } from "../domain/queue/due.ts";
import { queueStep } from "../domain/queue/open.ts";
import { recoverFirstMessages } from "../domain/queue/recover.ts";
import { CLAIM_MODES } from "../domain/send/constants.ts";
import { nextStep } from "../domain/send/next.ts";
import { checkAccounts, dueChecks } from "../domain/send/recover.ts";
import { openWithdrawals } from "../domain/withdraw/open.ts";
import { FILE_KEY_MAX, TICK_MINUTES, WITHDRAW_CRON, WITHDRAW_ZONE } from "./constants.ts";
import { prepareProfile, settleProfile } from "./profile.ts";
import { startQueueRuns } from "./queue.ts";
import { claim, gate, prepare, settle } from "./sender.ts";
import { startWithdrawals } from "./withdraw.ts";

let log: Logger | undefined;
const logger = (): Logger => (log ??= createLogger());

const id = z.string().min(1).max(ID_MAX);
const instant = z.iso.datetime();
const code = z.string().min(1).max(ID_MAX);
const claimedInput = workflowInput.extend({
  stepExecutionId: id,
  reservationId: id,
  usageId: id.nullable(),
});
/**
 * linkedin's send answers (its SendResult): sent, refused before the call, or a port's error; and
 * its check's (CheckSentResult, beta-p4-040): whether a step left `executing` went out.
 */
const sendAnswer = z.union([
  z.strictObject({ sent: z.literal(true), stepExecutionId: id }),
  z.strictObject({ refused: code, retryAt: instant.nullable() }),
  z.strictObject({ refused: code, retryAfterSec: z.number().nonnegative().optional() }),
  z.strictObject({ outcome: z.enum(["sent", "not_sent"]), stepExecutionId: id }),
]);
/** linkedin's profile read's answers (its ProfileRead, ProfileRefused): the file's key, or a refusal. */
const profileAnswer = z.union([
  z.strictObject({ key: z.string().min(1).max(FILE_KEY_MAX) }),
  z.strictObject({ refused: code }),
]);
/** A check's step: no reservation, campaigns keeps none; its credits' usage from the claim. */
const checkedInput = claimedInput.extend({ reservationId: id.nullable() });

export const workflows = defineWorkflows({
  campaigns_plan: { input: workflowInput, taskQueue: DEFAULT_TASK_QUEUE },
  campaigns_plan_tick: {
    input: globalWorkflowInput,
    taskQueue: DEFAULT_TASK_QUEUE,
    scope: "global",
  },
  campaigns_queue: { input: workflowInput, taskQueue: DEFAULT_TASK_QUEUE },
  campaigns_queue_tick: {
    input: globalWorkflowInput,
    taskQueue: DEFAULT_TASK_QUEUE,
    scope: "global",
  },
  campaigns_sender: {
    input: workflowInput.extend({ accountId: id }),
    taskQueue: DEFAULT_TASK_QUEUE,
  },
  campaigns_withdraw: { input: workflowInput, taskQueue: DEFAULT_TASK_QUEUE },
  campaigns_withdraw_tick: {
    input: globalWorkflowInput,
    taskQueue: DEFAULT_TASK_QUEUE,
    scope: "global",
  },
});

/**
 * The start of the workspace's plan: one run at a time by its fixed id, so a tick while one runs
 * starts none, and two runs never place times for one account together.
 */
export function planStart(workspaceId: string): WorkflowStart {
  return {
    workflow: "campaigns_plan",
    input: { workspaceId },
    workflowId: `campaigns.plan:${workspaceId}:current`,
    oneAtATime: true,
  };
}

/**
 * The start of the account's sender: one run at a time by its fixed id, so the plan's start while
 * one runs makes none, and the account has one writer of its sends.
 */
export function senderStart(workspaceId: string, accountId: string): WorkflowStart {
  return {
    workflow: "campaigns_sender",
    input: { workspaceId, accountId },
    workflowId: `campaigns.sender:${workspaceId}:${accountId}`,
    oneAtATime: true,
  };
}

export const activities = {
  /** The tick's: every workspace's plan started, unless one runs; the counts. */
  campaigns_start_plans: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: startPlans,
  }),
  /** The workspace's: each sender account of its scheduled steps planned; the counts. */
  campaigns_plan_accounts: defineActivity({
    kind: "db",
    input: workflowInput,
    run: (_input, context: ActivityContext<TenantClient>) => planAccounts(context),
  }),
  /** The queue's tick's: every workspace's queue run started for the tick's slot; the counts. */
  campaigns_start_queue_runs: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: () => startQueueRuns(now()),
  }),
  /**
   * The workspace's steps due within the queue window, oldest first; first, a first message left
   * without a due time given one once it can have one (beta-p4-040).
   */
  campaigns_due_steps: defineActivity({
    kind: "db",
    input: workflowInput,
    run: async (_input, context) => {
      await context.tenant(() => recoverFirstMessages(now()));
      return { stepIds: await context.tenant(() => dueStepIds(now())) };
    },
  }),
  /** One step's item opened, in a tenant run of its own; what its turn did. */
  campaigns_queue_step: defineActivity({
    kind: "db",
    input: workflowInput.extend({ stepExecutionId: z.string().min(1).max(ID_MAX) }),
    run: async ({ stepExecutionId }, context) => ({
      outcome: await context.tenant(() => queueStep(stepExecutionId)),
    }),
  }),
  /** The sender's next step placed today and how long to wait for it; none ends the run. */
  campaigns_sender_next: defineActivity({
    kind: "db",
    input: workflowInput.extend({ accountId: id }),
    run: ({ accountId }, context) => context.tenant(() => nextStep(accountId, now())),
  }),
  /**
   * The gate, then the claim with its credits and slot; or the chat's read refused, recorded. Around
   * a profile read (beta-p4-030): the credits alone, then the slot of the step charged (`usageId`).
   */
  campaigns_sender_claim: defineActivity({
    kind: "db",
    input: workflowInput.extend({
      stepExecutionId: id,
      scheduledFor: instant,
      readRefused: z.strictObject({ refused: code, retryAt: instant.nullable() }).optional(),
      mode: z.enum(CLAIM_MODES).optional(),
      usageId: id.nullable().optional(),
    }),
    run: (input, context: ActivityContext<TenantClient>) => claim(input, context),
  }),
  /** The claimed step's request file under raw/; or why it waits, its holds freed. */
  campaigns_sender_prepare: defineActivity({
    kind: "db",
    input: checkedInput.extend({ check: z.literal(true).optional() }),
    run: (input, context: ActivityContext<TenantClient>) => prepare(input, context),
  }),
  /** The gate right before the call, against the file's text; a block frees the holds. */
  campaigns_sender_gate: defineActivity({
    kind: "db",
    input: claimedInput,
    run: (input, context: ActivityContext<TenantClient>) => gate(input, context),
  }),
  /** The step settled on linkedin's answer; a send's credits past their lease logged uncharged. */
  campaigns_sender_settle: defineActivity({
    kind: "db",
    input: checkedInput.extend({ answer: sendAnswer }),
    run: async (input, context: ActivityContext<TenantClient>) => {
      const settled = await settle(input, context);
      if (settled.uncharged !== null) {
        const fields = {
          step_execution_id: input.stepExecutionId,
          credit_usage_id: settled.uncharged,
        };
        logger().warn(fields, "campaigns: send_uncharged");
      }
      return settled;
    },
  }),
  /** The account's `executing` steps due for their check, with their credits (beta-p4-040). */
  campaigns_sender_checks: defineActivity({
    kind: "db",
    input: workflowInput.extend({ accountId: id }),
    run: async ({ accountId }, context: ActivityContext<TenantClient>) => ({
      checks: await context.tenant(() => dueChecks(accountId, now())),
    }),
  }),
  /** The withdrawal job's tick's: every workspace's run of the day started; the counts. */
  campaigns_start_withdrawals: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: () => startWithdrawals(now()),
  }),
  /** The workspace's withdrawals opened, in one tenant run; how many are new. */
  campaigns_open_withdrawals: defineActivity({
    kind: "db",
    input: workflowInput,
    run: (_input, context: ActivityContext<TenantClient>) =>
      context.tenant(() => openWithdrawals(now())),
  }),
  /** The profile read of a charged invite reserved, its request file under raw/; or why not. */
  campaigns_profile_prepare: defineActivity({
    kind: "db",
    input: workflowInput.extend({ stepExecutionId: id, usageId: id.nullable() }),
    run: (input, context: ActivityContext<TenantClient>) => prepareProfile(input, context),
  }),
  /** The read settled on linkedin's answer, the member id stored; or the step's end or wait. */
  campaigns_profile_settle: defineActivity({
    kind: "db",
    input: workflowInput.extend({
      stepExecutionId: id,
      usageId: id.nullable(),
      reservationId: id,
      answer: profileAnswer.nullable(),
    }),
    run: (input, context: ActivityContext<TenantClient>) => settleProfile(input, context),
  }),
};

/**
 * Every TICK_MINUTES, the plan and the queue; daily at 05:00 UTC, the withdrawal job. Temporal's
 * default overlap policy skips a start while a run is open.
 */
export const schedules = defineSchedules([
  {
    id: "plan",
    workflow: "campaigns_plan_tick",
    spec: { intervals: [{ every: `${TICK_MINUTES} minutes` }] },
    input: {},
  },
  {
    id: "queue",
    workflow: "campaigns_queue_tick",
    spec: { intervals: [{ every: `${TICK_MINUTES} minutes` }] },
    input: {},
  },
  {
    id: "withdraw",
    workflow: "campaigns_withdraw_tick",
    spec: { cronExpressions: [WITHDRAW_CRON], timezone: WITHDRAW_ZONE },
    input: {},
  },
]);

/**
 * Tenancy's workspaces, each one's plan started with oneAtATime. One that fails leaves the others
 * started, and the tick then fails with its code.
 */
async function startPlans(): Promise<{ workspaces: number; started: number }> {
  // Tenancy's list: no module reads another's tables (decisions.md, 2026-10-22).
  const workspaceIds = await listWorkspaceIds();
  const failures: unknown[] = [];
  let started = 0;
  for (const workspaceId of workspaceIds) {
    try {
      if ((await startWorkflow(planStart(workspaceId))).started) started += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
  return { workspaces: workspaceIds.length, started };
}

/**
 * The accounts of the workspace's scheduled steps, each planned at the time of its own run, then its
 * sender started when it has a step placed for today (a running one starts none). One that fails
 * leaves the others planned, and the activity then fails with its code; Temporal tries it again,
 * and a plan run again keeps the times it placed. An account with an `executing` step due for its
 * check is planned too, and its sender started while it may act (beta-p4-040).
 */
async function planAccounts(
  context: ActivityContext<TenantClient>,
): Promise<{ accounts: number; placed: number }> {
  const scheduled = await context.tenant(() => scheduledAccounts());
  const checking = new Set(await context.tenant(() => checkAccounts(now())));
  const accountIds = [...new Set([...scheduled, ...checking])].sort();
  const failures: unknown[] = [];
  let placed = 0;
  for (const accountId of accountIds) {
    try {
      const { plan, today } = await context.tenant(async () => {
        const plan = await planAccount(accountId, now());
        return { plan, today: plan.skipped === null && (await placedToday(accountId, now())) };
      });
      placed += plan.placed;
      const due = today || (plan.skipped === null && checking.has(accountId));
      const start = due && (await startWorkflow(senderStart(context.workspaceId, accountId)));
      const { skipped, kept, released } = plan;
      const fields = {
        ...{ sender_account_id: accountId, skipped, kept, released, placed: plan.placed },
        sender_started: start !== false && start.started,
      };
      logger().info(fields, "campaigns: account planned");
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
  return { accounts: accountIds.length, placed };
}

/** The worker's start: the host's logger, for the plan's lines and a send left uncharged. */
export async function onWorkerStart(context: { readonly log: Logger }): Promise<void> {
  log = context.log;
}
