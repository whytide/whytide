// Did a step's send go out (docs/flows.md "The send activities"): the decision from the port's answers,
// pure, before a retry and in linkedin_check_sent. An invite went out when the member is invited or
// connected; a withdrawal when no invitation is pending; a message when the chat holds one from the
// account sent since the key's first reservation, less SEND_CHECK_SKEW_MS. Each errs to "went out":
// one send missed is a step to redo by hand, one sent twice cannot be taken back. And the reply that
// linkedin_check_reply finds: the person's latest message after the last send.
import type { LinkedinRelation, RecentMessage } from "@whytide/providers";
import { SEND_CHECK_SKEW_MS } from "./constants.ts";

/** What the check read: the relation for an invite or a withdrawal, the chat's messages for a message. */
export type CheckAnswer =
  | { readonly actionType: "invite" | "withdraw"; readonly relation: LinkedinRelation }
  | {
      readonly actionType: "message";
      readonly messages: readonly RecentMessage[];
      readonly since: Date;
    };
/** Went out, with the account's latest such message for a message; null when it did not. */
export type WentOut = { readonly message?: RecentMessage } | null;

/** The earliest time a message of the step may carry: the key's first reservation, less the skew. */
export const messagesSince = (firstReservedAt: Date): Date =>
  new Date(firstReservedAt.getTime() - SEND_CHECK_SKEW_MS);

export function wentOut(answer: CheckAnswer): WentOut {
  if (answer.actionType !== "message") {
    const { connected, invitationPending } = answer.relation;
    if (answer.actionType === "withdraw") return invitationPending ? null : {};
    return connected || invitationPending ? {} : null;
  }
  const since = answer.since.getTime();
  const ours = answer.messages.filter((m) => m.fromAccount && m.sentAt.getTime() >= since);
  const message = ours.toSorted((a, b) => a.sentAt.getTime() - b.sentAt.getTime()).at(-1);
  return message === undefined ? null : { message };
}

/** The person's latest message after `since` (the last send), or null. */
export function repliedAt(messages: readonly RecentMessage[], since: Date): Date | null {
  const theirs = messages.filter((m) => !m.fromAccount && m.sentAt.getTime() > since.getTime());
  const times = theirs.map((m) => m.sentAt.getTime());
  return times.length === 0 ? null : new Date(Math.max(...times));
}
