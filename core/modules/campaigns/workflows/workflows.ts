// campaigns' workflows, run in Temporal's sandbox (README.md "Worker", "The queue"): the daily plan's
// tick, global, which starts one plan per workspace, and the workspace's plan, each one activity; the
// queue's tick, global, which starts one queue run per workspace, and the workspace's queue run, its
// due steps then one activity per step; and an account's sender, its steps placed today one at a
// time; the withdrawal job's tick, global, daily, which starts one run per workspace, and that run,
// each one activity. Ids in, counts out. Long waits are rows the plan and the queue read every
// tick, never timers here (architecture §8); the sender sleeps only until a time placed today, a
// tick at most at once, and the minutes after a profile read before the connection request it is
// for (beta-p4-030). beta-p4-040, behind patched(CHECK_EXECUTING): the sender checks its steps
// left `executing` before its first claim, asks the gate again when its pass is stale, and goes on
// after invites_paused; a send activity is never retried by Temporal.
import {
  ActivityCancellationType,
  isCancellation,
  patched,
  proxyActivities,
  sleep,
} from "@temporalio/workflow";
import type {
  CheckReplyResult,
  CheckSentResult,
  ProfileRead,
  ProfileRefused,
  ReadProfile,
  SendResult,
} from "@whytide/linkedin";
import type { ActivityFunctions } from "@whytide/platform";
import type { ChargeAnswer, ClaimAnswer } from "../domain/send/claim.ts";
import { ACTION_REFUSALS, RUN_ENDING_REFUSALS } from "../domain/send/constants.ts";
import {
  CHECK_EXECUTING,
  MEMBER_REFERENCE_PATCH,
  PLAN_TIMEOUT,
  PROFILE_READ_ATTEMPTS,
  PROFILE_READ_TIMEOUT,
  QUEUE_TIMEOUT,
  SEND_ACTIVITY_TIMEOUT,
  SEND_ATTEMPTS,
  SEND_START_TIMEOUT,
  SENDER_SLEEP_MAX_MS,
  SENDER_TIMEOUT,
  WITHDRAW_TIMEOUT,
} from "./constants.ts";
import type { activities } from "./index.ts";

const steps = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: PLAN_TIMEOUT,
});
const queueing = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: QUEUE_TIMEOUT,
});
const sending = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: SENDER_TIMEOUT,
});
type ClaimInput = Parameters<ActivityFunctions<typeof activities>["campaigns_sender_claim"]>[0];
/** The claim by its mode: the credits alone answer a charge (beta-p4-030), any other a claim. */
type Claiming = {
  campaigns_sender_claim(input: ClaimInput & { mode: "credits" }): Promise<ChargeAnswer>;
  campaigns_sender_claim(input: ClaimInput): Promise<ClaimAnswer>;
};
const claiming = proxyActivities<Claiming>({ startToCloseTimeout: SENDER_TIMEOUT });

/** linkedin's activities the sender calls by name (its workflows/send.ts): ids in, codes out. */
type SendInput = {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly reservationId: string;
  readonly requestKey: string;
  readonly stepAttempt: number;
};
type LinkedinActivities = {
  linkedin_check_reply(input: {
    workspaceId: string;
    accountId: string;
    personId: string;
  }): Promise<CheckReplyResult>;
  linkedin_send_invite(input: SendInput): Promise<SendResult>;
  linkedin_send_message(input: SendInput): Promise<SendResult>;
  linkedin_withdraw_invite(input: SendInput): Promise<SendResult>;
  linkedin_check_sent(input: {
    workspaceId: string;
    accountId: string;
    requestKey: string;
  }): Promise<CheckSentResult>;
};
// A cancellation waits for the call's attempt to end, so the run never closes while it may send.
const linkedin = proxyActivities<LinkedinActivities>({
  startToCloseTimeout: SEND_ACTIVITY_TIMEOUT,
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});
// The send activities: one attempt, started soon after the gate (constants.ts, beta-p4-040).
const sends = proxyActivities<LinkedinActivities>({
  startToCloseTimeout: SEND_ACTIVITY_TIMEOUT,
  scheduleToStartTimeout: SEND_START_TIMEOUT,
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: SEND_ATTEMPTS },
});
const SEND_ACTIVITY = {
  invite: "linkedin_send_invite",
  message: "linkedin_send_message",
  withdraw: "linkedin_withdraw_invite",
} as const;

export async function campaigns_plan_tick(
  input: Record<string, never>,
): Promise<{ workspaces: number; started: number }> {
  return steps.campaigns_start_plans(input);
}

export async function campaigns_plan(input: {
  workspaceId: string;
}): Promise<{ accounts: number; placed: number }> {
  return steps.campaigns_plan_accounts(input);
}

/** What a queue run did, counted by each step's outcome; `failed`, a step that failed past its attempts. */
export type QueueCounts = {
  readonly opened: number;
  readonly passedOver: number;
  readonly noSender: number;
  readonly failed: number;
};

export async function campaigns_queue_tick(
  input: Record<string, never>,
): Promise<{ workspaces: number; started: number }> {
  return queueing.campaigns_start_queue_runs(input);
}

export async function campaigns_queue(input: { workspaceId: string }): Promise<QueueCounts> {
  const { workspaceId } = input;
  const { stepIds } = await queueing.campaigns_due_steps(input);
  const counts = { opened: 0, passedOver: 0, noSender: 0, failed: 0 };
  for (const stepExecutionId of stepIds) {
    try {
      const { outcome } = await queueing.campaigns_queue_step({ workspaceId, stepExecutionId });
      if (outcome === "opened") counts.opened += 1;
      else if (outcome === "no_sender") counts.noSender += 1;
      else counts.passedOver += 1;
    } catch (error) {
      if (isCancellation(error)) throw error;
      // One step that fails leaves the others queued; it stays planned for the next tick.
      counts.failed += 1;
    }
  }
  return counts;
}

/**
 * What a sender run did, and why it ended: no step left today, a refusal that ends it, or a step
 * left `executing` with its holds (a refused check, a port's error, an unknown outcome).
 */
export type SenderRun = {
  readonly sent: number;
  readonly blocked: number;
  readonly refused: number;
  readonly end: "no_step" | "refused" | "unsettled";
};

/**
 * The account's sender (docs/flows.md "The sender"): its steps left `executing` checked first; then
 * its next step placed today, the wait for its time and a gap after the last send, the chat read
 * before a message, the claim, the request file, the gate again, linkedin's activity by name, the
 * settle; then the next step, until none is left or an answer ends the run.
 */
export async function campaigns_sender(input: {
  workspaceId: string;
  accountId: string;
}): Promise<SenderRun> {
  const { workspaceId, accountId } = input;
  const recovers = patched(CHECK_EXECUTING);
  const counts = { sent: 0, blocked: 0, refused: 0 };
  const end = (why: SenderRun["end"]): SenderRun => ({ ...counts, end: why });
  const checked = recovers ? await checkExecuting(input, counts) : null;
  if (checked !== null) return end(checked);
  for (;;) {
    const { step } = await sending.campaigns_sender_next(input);
    if (step === null) return end("no_step");
    if (step.waitMs > 0) {
      await sleep(Math.min(step.waitMs, SENDER_SLEEP_MAX_MS));
      continue;
    }
    const { stepExecutionId, scheduledFor } = step;
    const read =
      step.actionType === "message"
        ? await linkedin.linkedin_check_reply({ ...input, personId: step.personId })
        : null;
    const readRefused = read !== null && "refused" in read ? read : undefined;
    // An answer of `next` recorded before beta-p4-030 has no flag: such a run replays its claim.
    const claim =
      step.memberRefUnknown === true && patched(MEMBER_REFERENCE_PATCH)
        ? await readProfileFirst({ ...input, stepExecutionId, scheduledFor })
        : await claiming.campaigns_sender_claim({
            ...{ workspaceId, stepExecutionId, scheduledFor },
            ...(readRefused !== undefined && { readRefused }),
          });
    if ("blocked" in claim) {
      counts.blocked += 1;
      continue;
    }
    if ("refused" in claim) {
      counts.refused += 1;
      if (endsRun(claim, recovers)) return end("refused");
      continue;
    }
    const { reservationId, usageId, attempt } = claim;
    const claimed = { workspaceId, stepExecutionId, reservationId, usageId };
    const prepared = await sending.campaigns_sender_prepare(claimed);
    if ("waiting" in prepared || !(await gated(claimed, recovers))) {
      counts.blocked += 1;
      continue;
    }
    let answer: SendResult;
    try {
      const { requestKey } = prepared;
      const send = { workspaceId, accountId, reservationId, requestKey, stepAttempt: attempt };
      answer = await sends[SEND_ACTIVITY[step.actionType]](send);
    } catch (error) {
      if (isCancellation(error)) throw error;
      // No answer: the send may have gone out, so the step stays `executing` with its holds.
      return end("unsettled");
    }
    const settled = await sending.campaigns_sender_settle({ ...claimed, answer });
    if (settled.outcome === "sent") counts.sent += 1;
    else counts.refused += 1;
    if (settled.end) return end(settled.outcome === "kept" ? "unsettled" : "refused");
  }
}

/**
 * A refusal ends the run when it names no time, or is the account's rate limit; with the patch, one
 * action's refusal (invites_paused) leaves the account's other actions going.
 */
function endsRun(
  refusal: { readonly refused: string; readonly retryAt: string | null },
  recovers: boolean,
): boolean {
  const ending: readonly string[] = RUN_ENDING_REFUSALS;
  const action: readonly string[] = recovers ? ACTION_REFUSALS : [];
  const untimed = refusal.retryAt === null && !action.includes(refusal.refused);
  return untimed || ending.includes(refusal.refused);
}

type Claimed = {
  readonly workspaceId: string;
  readonly stepExecutionId: string;
  readonly reservationId: string;
  readonly usageId: string | null;
};

/**
 * The gate right before the call; with the patch, asked again while its pass is older than it holds
 * when the call is scheduled, in workflow time, as after a stop between the two. Whether it passed.
 */
async function gated(claimed: Claimed, recovers: boolean): Promise<boolean> {
  for (;;) {
    const askedAt = Date.now();
    const gate = await sending.campaigns_sender_gate(claimed);
    if (!gate.pass) return false;
    if (!recovers || Date.now() - askedAt <= gate.freshForMs) return true;
  }
}

/**
 * Before the first claim (beta-p4-040; docs/flows.md "The check first"): each of the account's
 * steps left `executing` and due for its check, its request file written again, linkedin's check,
 * and the settle on its answer. Why the run ends, or null to go on to the claims.
 */
async function checkExecuting(
  input: { readonly workspaceId: string; readonly accountId: string },
  counts: { sent: number },
): Promise<SenderRun["end"] | null> {
  const { workspaceId, accountId } = input;
  const { checks } = await sending.campaigns_sender_checks(input);
  for (const { stepExecutionId, usageId } of checks) {
    const held = { workspaceId, stepExecutionId, reservationId: null, usageId };
    const prepared = await sending.campaigns_sender_prepare({ ...held, check: true });
    if ("waiting" in prepared) continue;
    let answer: CheckSentResult;
    try {
      const { requestKey } = prepared;
      answer = await linkedin.linkedin_check_sent({ workspaceId, accountId, requestKey });
    } catch (error) {
      if (isCancellation(error)) throw error;
      return "unsettled";
    }
    const settled = await sending.campaigns_sender_settle({ ...held, answer });
    if (settled.outcome === "sent") counts.sent += 1;
    if (settled.end) return settled.outcome === "kept" ? "unsettled" : "refused";
  }
  return null;
}

const withdrawing = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: WITHDRAW_TIMEOUT,
});

/** The withdrawal job's daily tick (README.md "Withdrawals"): each workspace's run started. */
export async function campaigns_withdraw_tick(
  input: Record<string, never>,
): Promise<{ workspaces: number; started: number }> {
  return withdrawing.campaigns_start_withdrawals(input);
}

/** The workspace's withdrawals opened: one withdraw step per connection request left too long. */
export async function campaigns_withdraw(input: {
  workspaceId: string;
}): Promise<{ opened: number }> {
  return withdrawing.campaigns_open_withdrawals(input);
}

/** linkedin's profile read, called by name as signals calls it (its workflows/index.ts). */
type ProfileReader = {
  linkedin_read_profile(input: ReadProfile): Promise<ProfileRead | ProfileRefused>;
};
// As a send's: a cancellation waits for the read's attempt to end, so the run knows it was made.
// linkedin's read attempts at most, not the worker's five (constants.ts, beta-p4-040).
const reading = proxyActivities<ProfileReader>({
  startToCloseTimeout: PROFILE_READ_TIMEOUT,
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: PROFILE_READ_ATTEMPTS },
});

/**
 * A connection request whose person has no member id (beta-p4-030; docs/flows.md "The read before an
 * invite"): the claim's credits alone, so an empty balance reads nothing; the read reserved with its
 * request file, linkedin's read, its settle storing the member id; the wait after the read, then the
 * claim's gate again and the slot. The claim's answer, for beta-p4-020's path from the request file
 * on; a refusal, or the step ended (`blocked`, profile_unreadable), as the claim answers them.
 */
async function readProfileFirst(input: {
  workspaceId: string;
  accountId: string;
  stepExecutionId: string;
  scheduledFor: string;
}): Promise<ClaimAnswer> {
  const { workspaceId, accountId, stepExecutionId, scheduledFor } = input;
  const placed = { workspaceId, stepExecutionId, scheduledFor };
  const charge = await claiming.campaigns_sender_claim({ ...placed, mode: "credits" });
  if (!("charged" in charge)) return charge;
  const charged = { workspaceId, stepExecutionId, usageId: charge.usageId };
  const prepared = await sending.campaigns_profile_prepare(charged);
  if (!("reservationId" in prepared)) return prepared;
  const { reservationId, requestKey, rawKey } = prepared;
  let answer: ProfileRead | ProfileRefused | null;
  try {
    answer = await reading.linkedin_read_profile({ workspaceId, accountId, requestKey, rawKey });
  } catch (error) {
    if (isCancellation(error)) throw error;
    // No answer past the read's attempts: settled as not made, and the step waits.
    answer = null;
  }
  const settled = await sending.campaigns_profile_settle({ ...charged, reservationId, answer });
  if (!("stored" in settled)) return settled;
  await sleep(settled.waitMs);
  return claiming.campaigns_sender_claim({ ...placed, mode: "slot", usageId: charge.usageId });
}
