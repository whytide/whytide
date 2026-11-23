// inbox's workflows, run in Temporal's sandbox: one message the receiver kept, through the activity
// inbox_store (README.md "The store"); one reply's mail to its account's owner, through the activity
// inbox_mail_reply (README.md "The reply mail"); one member's reply from the inbox, through
// inbox_reply_begin, the channel's read of the chat and send activity by name, inbox_reply_settle
// and, after an unknown outcome, the channel's check (README.md "Replies from the inbox"); one reply
// draft, through inbox_write_reply_draft, marked failed with its failure's code past its attempts, and
// the drafts' sweep, workspace by workspace (README.md "The reply draft"); one stored reply's
// classification, through inbox_classify, given the fallback by inbox_classify_failed past its
// attempts (README.md "The classifier"). Ids in, ids, booleans, statuses and codes out: never a text.
import {
  ActivityCancellationType,
  ActivityFailure,
  ApplicationFailure,
  isCancellation,
  proxyActivities,
  sleep,
} from "@temporalio/workflow";
import type { CheckReplyResult, CheckSentResult, SendResult } from "@whytide/linkedin";
import type { ActivityFunctions } from "@whytide/platform";
import type { Classified } from "../domain/classify/classify.ts";
import type { SendStatus } from "../domain/reply/constants.ts";
import { CODE_PATTERN, WRITE_FAILED } from "../domain/reply-draft/constants.ts";
import type { DraftRun } from "../domain/reply-draft/write.ts";
import {
  CLASSIFY_TIMEOUTS,
  DRAFT_SWEEP,
  DRAFT_TIMEOUTS,
  MAIL_TIMEOUT,
  REPLY_CHECKS,
  REPLY_TIMEOUT,
  SEND_ACTIVITY_TIMEOUT,
  SEND_ATTEMPTS,
  SEND_START_TIMEOUT,
  STORE_TIMEOUT,
} from "./constants.ts";
import type {
  activities,
  ClassifyInput,
  DraftInput,
  MailInput,
  ReplyInput,
  StoreInput,
} from "./index.ts";

const { inbox_store } = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: STORE_TIMEOUT,
});

export async function inbox_store_message(input: StoreInput) {
  return inbox_store(input);
}

const { inbox_mail_reply } = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: MAIL_TIMEOUT,
});

export async function inbox_reply_mail(input: MailInput) {
  return inbox_mail_reply(input);
}

const replying = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: REPLY_TIMEOUT,
});
/** linkedin's activities the reply calls by name (its workflows/send.ts), as campaigns' does. */
type LinkedinActivities = {
  linkedin_check_reply(input: {
    workspaceId: string;
    accountId: string;
    personId: string;
  }): Promise<CheckReplyResult>;
  linkedin_send_message(input: {
    workspaceId: string;
    accountId: string;
    reservationId: string;
    requestKey: string;
    stepAttempt: number;
  }): Promise<SendResult>;
  linkedin_check_sent(input: {
    workspaceId: string;
    accountId: string;
    requestKey: string;
  }): Promise<CheckSentResult>;
};
// A cancellation waits for the call's attempt to end, so the run never closes while it may send.
const checks = proxyActivities<LinkedinActivities>({
  startToCloseTimeout: SEND_ACTIVITY_TIMEOUT,
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});
// The send: one attempt, started soon after the begin; a retry is the check, asked below.
const sends = proxyActivities<LinkedinActivities>({
  startToCloseTimeout: SEND_ACTIVITY_TIMEOUT,
  scheduleToStartTimeout: SEND_START_TIMEOUT,
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: SEND_ATTEMPTS },
});

/** Where the reply ended: its status, `sending` while its outcome is still unknown, or gone. */
export type ReplyRun = { readonly status: SendStatus | "gone" };

/**
 * One member's reply (docs/flows.md "A reply from the inbox"): the begin, which checks again and
 * reserves, or settles the row; the chat read since the account's last send; the channel's send,
 * once; the settle on its answer; while the outcome is unknown, up to REPLY_CHECKS checks, each after
 * the settle's wait, never a second send.
 */
export async function inbox_send_reply(input: ReplyInput): Promise<ReplyRun> {
  const { workspaceId, messageId } = input;
  const begun = await replying.inbox_reply_begin(input);
  if ("settled" in begun) return { status: begun.settled };
  const { accountId, personId, reservationId, requestKey } = begun;
  const settle = (phase: "read" | "send" | "check", answer: Answer, code: string | null) =>
    replying.inbox_reply_settle({
      ...{ workspaceId, messageId, accountId, reservationId },
      ...{ phase, answer, code },
    });
  let answer: Answer = null;
  switch (begun.channel) {
    case "linkedin": {
      // The chat read since the account's last send before this send moves it, as campaigns' sender
      // reads it before a message: a message of the person's that no webhook brought is marked, so
      // campaigns' gate holds its next step. Refused, nothing is sent; on a retry, an earlier run may
      // have sent, so the outcome is left to the check.
      const chat = await checks.linkedin_check_reply({ workspaceId, accountId, personId });
      if ("refused" in chat) {
        if (begun.retry) break;
        const refused = await settle("read", chat, null);
        return { status: refused.status === "unknown" ? "sending" : refused.status };
      }
      // A retry (an earlier run's file) is asked as one: linkedin checks before it calls.
      const stepAttempt = begun.retry ? 2 : 1;
      const send = { workspaceId, accountId, reservationId, requestKey, stepAttempt };
      answer = await noAnswerOnFailure(() => sends.linkedin_send_message(send));
    }
  }
  let settled = await settle("send", answer, null);
  for (let check = 0; settled.status === "unknown" && check < REPLY_CHECKS; check += 1) {
    const { code, waitMs } = settled;
    if (waitMs > 0) await sleep(waitMs);
    const read = { workspaceId, accountId, requestKey };
    settled = await settle(
      "check",
      await noAnswerOnFailure(() => checks.linkedin_check_sent(read)),
      code,
    );
  }
  return { status: settled.status === "unknown" ? "sending" : settled.status };
}

/** The channel's answer, or null for none: the activity failed, the send may have gone out. */
type Answer = SendResult | CheckSentResult | null;

async function noAnswerOnFailure(call: () => Promise<SendResult | CheckSentResult>) {
  try {
    return await call();
  } catch (error) {
    if (isCancellation(error)) throw error;
    return null;
  }
}

const { inbox_write_reply_draft } = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: DRAFT_TIMEOUTS.write,
});
const { inbox_reply_draft_failed } = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: DRAFT_TIMEOUTS.mark,
});
const { inbox_list_workspaces, inbox_sweep_reply_drafts } = proxyActivities<
  ActivityFunctions<typeof activities>
>({ startToCloseTimeout: DRAFT_SWEEP.timeout });

/** One reply draft: written, or past the writer's attempts failed with the failure's code. */
export async function inbox_draft_reply(input: DraftInput): Promise<DraftRun> {
  try {
    return await inbox_write_reply_draft(input);
  } catch (error) {
    if (isCancellation(error)) throw error;
    const cause = error instanceof ActivityFailure ? error.cause : undefined;
    const type = cause instanceof ApplicationFailure ? cause.type : undefined;
    const code = typeof type === "string" && CODE_PATTERN.test(type) ? type : WRITE_FAILED;
    await inbox_reply_draft_failed({ ...input, code });
    throw error;
  }
}

/** The drafts it failed, and the workspaces whose sweep failed past its attempts. */
export async function inbox_reply_draft_sweep(
  input: Record<string, never>,
): Promise<{ stuck: number; unswept: number }> {
  const { workspaceIds } = await inbox_list_workspaces(input);
  let stuck = 0;
  let unswept = 0;
  for (const workspaceId of workspaceIds) {
    try {
      stuck += (await inbox_sweep_reply_drafts({ workspaceId })).stuck;
    } catch (error) {
      if (isCancellation(error)) throw error;
      unswept += 1;
    }
  }
  return { stuck, unswept };
}

const { inbox_classify } = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: CLASSIFY_TIMEOUTS.classify,
});
const { inbox_classify_failed } = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: CLASSIFY_TIMEOUTS.fallback,
});

/**
 * One stored reply: classified and acted on; past the classifier's attempts, the fallback, other and
 * suggested, which acts on nothing, so the person stays held (README.md "The classifier").
 */
export async function inbox_classify_reply(input: ClassifyInput): Promise<Classified> {
  try {
    return await inbox_classify(input);
  } catch (error) {
    if (isCancellation(error)) throw error;
    return inbox_classify_failed(input);
  }
}
