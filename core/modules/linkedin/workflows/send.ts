// The send activities (README.md "Worker"; docs/flows.md "The send activities"): the only code that
// calls the LinkedIn port's send side, each under the caller's reservation, and the two checks, each
// under a read of its own. The order: the request file; the check first on a retry (the step's
// attempt or Temporal's above 1, or an earlier outcome unknown); the gate; the call, unless the
// attempt is late; the settle. A provider call sits between tenant runs, never inside one; a run's
// log rows are counted (linkedin.actions) once it has returned. A typed port error is an answer,
// never a throw.
import { text } from "node:stream/consumers";
import type { TenantClient } from "@whytide/db";
import {
  type ActivityContext,
  AppError,
  defineActivity,
  isAppError,
  workflowInput,
} from "@whytide/platform";
import {
  filesConfig,
  filesPort,
  getAdapter,
  linkedinPort,
  type RecentMessage,
} from "@whytide/providers";
import { z } from "zod";
import { countAction, logAction } from "../domain/action-log/log.ts";
import { linkedin } from "../domain/provider.ts";
import {
  beginCheck,
  beginReplyCheck,
  type CheckBegun,
  checkFailed,
  settleCheck,
  settleReplyCheck,
} from "../domain/send/check.ts";
import { type Gate, openGate, refuseInput } from "../domain/send/gate.ts";
import { settleFailed, settleSent } from "../domain/send/outcome.ts";
import type { Sent } from "../domain/send/outreach.ts";
import { type Logged, noteOf, outcomeUnknown, type Step } from "../domain/send/step.ts";
import type { CheckAnswer } from "../domain/send/went-out.ts";
import { errors } from "../errors.ts";
import { PERSON_ID, type SendActionType } from "../schemas/quota.ts";
import {
  type CheckReplyResult,
  type CheckSentResult,
  type SendRequestFile,
  type SendResult,
  type SendStep,
  sendRequestFile,
} from "../schemas/send.ts";
import {
  CHECK_SENT_ATTEMPTS,
  ID_MAX_CHARS,
  RAW_KEY,
  RAW_KEY_MAX_CHARS,
  SEND_CALL_MARGIN_MS,
  SEND_CALL_MIN_LEFT_MS,
} from "./constants.ts";
import { type RefContext, withDecryptedRef } from "./decrypt.ts";

type SendContext = RefContext & Pick<ActivityContext<TenantClient>, "attempt">;
type Port = Awaited<ReturnType<typeof linkedin>>;
type Open = Extract<Gate, { open: true }>;

const accountId = z.string().min(1).max(ID_MAX_CHARS);
const requestKey = z.string().max(RAW_KEY_MAX_CHARS).regex(RAW_KEY);
const sendInput = workflowInput.extend({
  accountId,
  reservationId: z.string().min(1).max(ID_MAX_CHARS),
  requestKey,
  stepAttempt: z.int().min(1),
});
const checkSentInput = workflowInput.extend({ accountId, requestKey });
const checkReplyInput = workflowInput.extend({ accountId, personId: z.string().regex(PERSON_ID) });
const { codes } = linkedinPort;
const PORT_CODES: ReadonlySet<string> = new Set([
  ...Object.values(linkedinPort.errors),
  codes.input,
  codes.output,
  codes.error,
]);
const INPUT_INVALID = { refused: "linkedin_input_invalid", retryAt: null } as const;

/** One of the port's codes, or its boundary's: an answer, never a throw (invites.ts asks it too). */
export const isPortError = (error: unknown): error is AppError =>
  isAppError(error) && PORT_CODES.has(error.code);

/** `fn` in one tenant run, its log rows counted once the run has returned. */
async function inRun<T>(context: RefContext, fn: () => Promise<Logged<T>>): Promise<T> {
  const { answer, logged } = await context.tenant(fn);
  for (const row of logged) countAction(row);
  return answer;
}

/**
 * The request file at `key`, or null when it is no send's: not JSON, or off the schema. A read that
 * fails throws, and Temporal retries the activity: it is no answer about the file.
 */
async function readRequest(workspaceId: string, key: string): Promise<SendRequestFile | null> {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  const { body } = await files.get({ workspaceId, key });
  const parsed = sendRequestFile.safeParse(parseJson(await text(body)));
  return parsed.success ? parsed.data : null;
}

/** The text as JSON, or null when it is none. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * No call from an attempt with less than SEND_CALL_MIN_LEFT_MS of SEND_CALL_MARGIN_MS left by its own
 * clock, which a slow check or provider can make: past its start-to-close Temporal starts the next
 * attempt, whether this one has returned or not, and both would send. The code is retried with the
 * slot kept, and the next attempt checks first.
 */
function refuseLate(startedAt: number): void {
  const left = SEND_CALL_MARGIN_MS - (performance.now() - startedAt);
  if (left < SEND_CALL_MIN_LEFT_MS) throw new AppError(errors.send_attempt_late);
}

/** A send activity of `actionType`. */
export async function sendStep(
  context: SendContext,
  input: SendStep,
  actionType: SendActionType,
): Promise<SendResult> {
  // The attempt's start, on a monotonic clock: linkedin's clock is the wall's, and tests set it.
  const startedAt = performance.now();
  const { accountId, reservationId, requestKey, stepAttempt } = input;
  const file = await readRequest(context.workspaceId, requestKey);
  if (file?.actionType !== actionType) {
    return inRun(context, () => refuseInput(accountId, actionType, reservationId));
  }
  const step: Step = { ...file, accountId };
  const retry =
    stepAttempt > 1 || context.attempt > 1 || (await context.tenant(() => outcomeUnknown(step)));
  if (retry) {
    const checked = await checkStep(context, step, false);
    if ("refused" in checked) return checked;
    if (checked.outcome === "sent") return { sent: true, stepExecutionId: step.stepExecutionId };
  }
  const gate = await inRun(context, () => openGate(step, reservationId, SEND_CALL_MARGIN_MS));
  if (!gate.open) return gate.answer;
  const adapter = await linkedin();
  let sent: Sent;
  try {
    sent = await withDecryptedRef(context, accountId, (ref) => {
      refuseLate(startedAt);
      return callPort(adapter, ref, step, gate);
    });
  } catch (error) {
    if (!isPortError(error)) throw error;
    return inRun(context, () => settleFailed(step, reservationId, error));
  }
  return inRun(context, () => settleSent(step, sent, reservationId));
}

/** The send itself, with the step's key: what went out, as the provider answered it. */
async function callPort(adapter: Port, providerAccountRef: string, step: Step, refs: Open) {
  const { memberRef, idempotencyKey } = step;
  if (step.actionType === "invite") {
    const note = noteOf(step);
    const input = { providerAccountRef, memberRef, note, idempotencyKey };
    const { invitationRef, sentAt: at } = await adapter.sendInvite(input);
    return { actionType: "invite", at, invitationRef, found: false } satisfies Sent;
  }
  if (step.actionType === "message") {
    const { chatRef } = refs;
    const input = { providerAccountRef, memberRef, chatRef, text: step.text, idempotencyKey };
    const { messageRef, sentAt: at, ...sent } = await adapter.sendMessage(input);
    return { actionType: "message", at, messageRef, chatRef: sent.chatRef } satisfies Sent;
  }
  // The gate refused a withdrawal without a known invitation.
  const invitationRef = refs.invitationRef ?? "";
  const { withdrawnAt: at } = await adapter.withdrawInvite({ providerAccountRef, invitationRef });
  return { actionType: "withdraw", at, found: false } satisfies Sent;
}

/** linkedin_check_sent's flow, a send's before a retry too, where a send not out keeps its slot. */
async function checkStep(
  context: RefContext,
  step: Step,
  release: boolean,
): Promise<CheckSentResult> {
  const begun = await context.tenant(() => beginCheck(step));
  if (!("readId" in begun)) return begun;
  const adapter = await linkedin();
  let answer: CheckAnswer;
  try {
    answer = await withDecryptedRef(context, step.accountId, (ref) =>
      askSent(adapter, ref, step, begun),
    );
  } catch (error) {
    if (!isPortError(error)) throw error;
    const { accountId, stepExecutionId } = step;
    return inRun(context, () => checkFailed(accountId, stepExecutionId, begun.readId, error, step));
  }
  return inRun(context, () => settleCheck(step, begun, answer, release));
}

/** An invite's or a withdrawal's relation; a message's chat since the key's first reservation. */
async function askSent(adapter: Port, ref: string, step: Step, begun: CheckBegun) {
  const { memberRef } = step;
  if (step.actionType !== "message") {
    const relation = await adapter.getRelation({ providerAccountRef: ref, memberRef });
    return { actionType: step.actionType, relation } satisfies CheckAnswer;
  }
  const { since, chatRef } = begun;
  const asked = { providerAccountRef: ref, memberRef, chatRef, since };
  const { messages } = await adapter.listRecentMessages(asked);
  return { actionType: "message", messages, since } satisfies CheckAnswer;
}

/** linkedin_check_sent: did the step of the request file at `requestKey` send. */
export async function checkSent(
  context: RefContext,
  input: { readonly accountId: string; readonly requestKey: string },
): Promise<CheckSentResult> {
  const { accountId } = input;
  const file = await readRequest(context.workspaceId, input.requestKey);
  if (file !== null) return checkStep(context, { ...file, accountId }, true);
  return inRun(context, async () => {
    const entry = {
      accountId,
      kind: "send_check",
      count: 1,
      outcome: INPUT_INVALID.refused,
    } as const;
    return { answer: INPUT_INVALID, logged: [await logAction(entry)] };
  });
}

/** linkedin_check_reply: has the person written since the account's last send. */
export async function checkReply(
  context: RefContext,
  input: { readonly accountId: string; readonly personId: string },
): Promise<CheckReplyResult> {
  const { accountId, personId } = input;
  const begun = await context.tenant(() => beginReplyCheck(accountId, personId));
  if (!("readId" in begun)) return begun;
  const { memberRef, chatRef, since } = begun;
  const adapter = await linkedin();
  let messages: readonly RecentMessage[];
  try {
    const read = (providerAccountRef: string) =>
      adapter.listRecentMessages({ providerAccountRef, memberRef, chatRef, since });
    ({ messages } = await withDecryptedRef(context, accountId, read));
  } catch (error) {
    if (!isPortError(error)) throw error;
    return inRun(context, () => checkFailed(accountId, personId, begun.readId, error));
  }
  return inRun(context, () => settleReplyCheck(accountId, personId, begun, messages));
}

const sendActivity = (actionType: SendActionType) =>
  defineActivity<typeof sendInput, SendResult, TenantClient>({
    kind: "provider",
    input: sendInput,
    run: (input, context) => sendStep(context, input, actionType),
  });

/** The five activities, which workflows/index.ts registers. */
export const sendActivities = {
  linkedin_send_invite: sendActivity("invite"),
  linkedin_send_message: sendActivity("message"),
  linkedin_withdraw_invite: sendActivity("withdraw"),
  linkedin_check_sent: defineActivity<typeof checkSentInput, CheckSentResult, TenantClient>({
    kind: "provider",
    attempts: CHECK_SENT_ATTEMPTS,
    input: checkSentInput,
    run: (input, context) => checkSent(context, input),
  }),
  linkedin_check_reply: defineActivity<typeof checkReplyInput, CheckReplyResult, TenantClient>({
    kind: "provider",
    input: checkReplyInput,
    run: (input, context) => checkReply(context, input),
  }),
};
