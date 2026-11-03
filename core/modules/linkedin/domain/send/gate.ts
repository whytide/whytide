// Before a send's port call, each in one run of the activity (docs/flows.md "The send activities"): a
// request file that is no send of the activity's, and the gate just before the call: a send of the
// key counted already; the activity's reservation open, of the step, with the margin left on its
// hold, and its note reserved; the switches and the account read again (sendStateRefusal, retries
// included, an invite counting the other invites in flight); the refs the call needs from the
// person's outreach row. A refusal releases the
// reservation it found open, in the run that logs it.
import type { ActionOutcome, SendActionType } from "../../schemas/quota.ts";
import type { SendRefused, SendSent } from "../../schemas/send.ts";
import { findAccount } from "../accounts.ts";
import { logAction } from "../action-log/log.ts";
import { now } from "../clock.ts";
import { settleSent } from "./outcome.ts";
import { outreachOf } from "./outreach.ts";
import { findSendReservation } from "./readers.ts";
import { releaseSend } from "./settle.ts";
import { sendStateRefusal } from "./state.ts";
import { isCounted, keyRows, type Logged, logStep, noteOf, type Step } from "./step.ts";

export type Gate =
  | { readonly open: true; readonly chatRef?: string; readonly invitationRef?: string }
  | { readonly open: false; readonly answer: SendSent | SendRefused };

/**
 * A request file off its schema, or of another action type: linkedin_input_invalid, logged, the
 * reservation released when it is open and of the account and the type.
 */
export async function refuseInput(
  accountId: string,
  actionType: SendActionType,
  reservationId: string,
): Promise<Logged<SendRefused>> {
  const held = await findSendReservation(reservationId);
  const ours = held?.senderAccountId === accountId && held.actionType === actionType;
  if (ours && held.status === "reserved") await releaseSend(held.id);
  const refused = "linkedin_input_invalid";
  const logged = [await logAction({ accountId, kind: actionType, count: 1, outcome: refused })];
  return { answer: { refused, retryAt: null }, logged };
}

/** Whether the call may go, with the refs it needs; else the answer, the slot settled and logged. */
export async function openGate(
  step: Step,
  reservationId: string,
  marginMs: number,
): Promise<Logged<Gate>> {
  const rows = await keyRows(step);
  // holderOf answers a live twin before a late commit: the step's send went out already.
  if (rows.some(isCounted)) {
    const { answer, logged } = await settleSent(step, null);
    return { answer: { open: false, answer }, logged };
  }
  const at = now();
  const held = rows.find((row) => row.id === reservationId);
  const refuse = async (refused: ActionOutcome, retryAt: Date | null = null) => {
    if (held?.status === "reserved") await releaseSend(held.id);
    const answer = { refused, retryAt: retryAt?.toISOString() ?? null };
    return { answer: { open: false as const, answer }, logged: [await logStep(step, refused)] };
  };
  const left = held === undefined ? 0 : held.expiresAt.getTime() - at.getTime();
  if (held?.status !== "reserved" || left < marginMs) return refuse("reservation_not_open");
  // The month's three notes were counted for a reservation made with one only.
  if (noteOf(step) !== undefined && !held.withNote) return refuse("linkedin_input_invalid");
  const account = await findAccount(step.accountId);
  const state = await sendStateRefusal(account, step.actionType, at, reservationId);
  if (state !== null) return refuse(state.refused, state.retryAt);
  const outreach = await outreachOf(step.accountId, step.personId);
  const invitationRef = outreach?.providerInvitationRef ?? undefined;
  if (step.actionType === "withdraw" && invitationRef === undefined) {
    return refuse("linkedin_input_invalid");
  }
  const chatRef = outreach?.providerChatRef ?? undefined;
  return { answer: { open: true, chatRef, invitationRef }, logged: [] };
}
