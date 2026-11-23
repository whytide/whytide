// The send activities' request file and answers (README.md "Worker"; workflows/send.ts): the caller
// writes the file under the workspace's raw/ (72 hours at most), so that no workflow input, result or
// history holds a member ref, a note or a text. It holds no chat ref and no invitation ref: the
// activity reads those from the person's outreach row, so provider refs stay in linkedin. An answer
// holds ids, codes, booleans, numbers and instants (ISO) only.
import { linkedinPort } from "@whytide/providers";
import { z } from "zod";
import { SEND_KEY_MAX_CHARS, type SendRefusedReason } from "../domain/send/constants.ts";
import { type ActionOutcome, PERSON_ID, SEND_REF } from "./quota.ts";

const { sendInvite, sendMessage } = linkedinPort.methods;
const step = {
  /** The step execution the send is, or the inbox message a member's reply is (SEND_REF). */
  stepExecutionId: z.string().regex(SEND_REF),
  personId: z.string().regex(PERSON_ID),
  /** The person's member id at the vendor, in the form the provider's webhooks carry. */
  memberRef: sendInvite.input.shape.memberRef,
  /** The step's key: its reservation's, and the one each port call carries. */
  idempotencyKey: z.string().min(1).max(SEND_KEY_MAX_CHARS),
};

/** One step's send: a connection request with a note or none (an empty note is none), a message, a withdrawal. */
export const sendRequestFile = z.discriminatedUnion("actionType", [
  z.strictObject({ ...step, actionType: z.literal("invite"), note: sendInvite.input.shape.note }),
  z.strictObject({ ...step, actionType: z.literal("message"), text: sendMessage.input.shape.text }),
  z.strictObject({ ...step, actionType: z.literal("withdraw") }),
]);
export type SendRequestFile = z.output<typeof sendRequestFile>;

/** A send activity's input, which workflows/index.ts parses. */
export type SendStep = {
  readonly workspaceId: string;
  readonly accountId: string;
  /** The caller's reserveSend for the step's key. */
  readonly reservationId: string;
  /** The request file under raw/. */
  readonly requestKey: string;
  /** The step's attempt, `step_executions.attempt`: above 1, the check runs before the call. */
  readonly stepAttempt: number;
};
/** The send went out: now, or on an earlier attempt, which the check found. */
export type SendSent = { readonly sent: true; readonly stepExecutionId: string };
/** No port call: a refusal before it, `retryAt` when to ask again, null for a switch or a defect. */
export type SendRefused = { readonly refused: ActionOutcome; readonly retryAt: string | null };
/**
 * The port's typed error after the call, settled by the error map; `reason` when the map keys its
 * row by one (SEND_REFUSED_REASONS), `retryAfterSec` for a rate limit.
 */
export type SendFailed = {
  readonly refused: ActionOutcome;
  readonly reason?: SendRefusedReason;
  readonly retryAfterSec?: number;
};
export type SendResult = SendSent | SendRefused | SendFailed;

/** Did the step's send go out; a refused read changes nothing. */
export type CheckSentResult =
  | { readonly outcome: "sent" | "not_sent"; readonly stepExecutionId: string }
  | SendRefused;
/** Has the person written since the last send: `checked` false when no chat or no send is known. */
export type CheckReplyResult =
  | { readonly checked: boolean; readonly replied: boolean }
  | SendRefused;
