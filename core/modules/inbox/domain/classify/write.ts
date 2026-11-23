// A classification's end (README.md "The classifier"; docs/flows.md "A reply classified"), in the
// caller's tenant run: the person's lead locked first, as the store and privacy's erasure take it,
// and the person still known; a phrase's opt_out whatever was decided, so that neither the model nor
// the fallback overrides the store's match; the row, once per message (a repeat ends the run there);
// when the message is still the person's newest reply and its thread's owner has not labeled it,
// campaigns' applyReplyLabel acts on the label and its answer is kept in actions_taken, while an
// older reply, or one the owner labeled before the model answered (gamma-p4-055: the owner's label
// is the one that acts), acts on nothing but its opt-out; then inbox.reply_classified, ids and the
// label. A person erased meanwhile gets nothing written.
import { applyReplyLabel, type ReplyActionLabel, type ReplyActionsTaken } from "@whytide/campaigns";
import { addOptOut } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { currentTenant, newId, publish } from "@whytide/platform";
import { events } from "../../events.ts";
import { ids } from "../../ids.ts";
import { REPLY_OPT_OUT } from "../store/constants.ts";
import { lockKnown } from "../store/person.ts";
import { type ClassifyOrigin, FALLBACK_CONFIDENCE, PHRASE_CONFIDENCE } from "./constants.ts";

/** What the classifier decided, before the row: the label, and the model call that gave it. */
export type Decision = {
  readonly label: ReplyActionLabel;
  readonly confidence: number;
  readonly suggested: boolean;
  readonly returnDate: string | null;
  readonly origin: ClassifyOrigin;
  readonly call: {
    readonly decisionRecordId: string;
    readonly modelId: string;
    readonly promptVersion: number;
  } | null;
};
/** One stored reply, as inbox.reply_received names it. */
export type ClassifyRequest = {
  readonly messageId: string;
  readonly threadId: string;
  readonly personId: string;
};
/** How a run ended: a status, the label's origin and whether the reply was the newest; never a text. */
export type Classified =
  | { readonly status: "classified"; readonly origin: ClassifyOrigin; readonly newest: boolean }
  | { readonly status: "repeat" | "gone" };

/** A phrase the store matched: opt_out, certain, with no model call. */
export const PHRASE: Decision = {
  ...{ label: "opt_out", confidence: PHRASE_CONFIDENCE, suggested: false, returnDate: null },
  ...{ origin: "phrase", call: null },
};
/** A failed classification: other, suggested, which acts on nothing; the call's record when there is one. */
export const fallback = (call: Decision["call"]): Decision => ({
  ...{ label: "other", confidence: FALLBACK_CONFIDENCE, suggested: true, returnDate: null },
  ...{ origin: "fallback", call },
});
const NOTHING: ReplyActionsTaken = { actions: [], enrollmentIds: [] };
const OPTED_OUT: ReplyActionsTaken = { actions: ["opted_out"], enrollmentIds: [] };

/** The decision written for the reply and acted on, in the caller's tenant run (the file's header). */
export async function writeClassification(
  request: ClassifyRequest,
  given: Decision,
): Promise<Classified> {
  const { messageId, personId } = request;
  if (!(await lockKnown(personId))) return { status: "gone" };
  const message = await tenantClient.message.findFirst({
    where: { id: messageId, personId, direction: "in" },
    select: { threadId: true, sentAt: true, optOutMatched: true },
  });
  if (message === null) return { status: "gone" };
  const { threadId, sentAt } = message;
  const where = { id: threadId };
  const thread = await tenantClient.thread.findFirst({ where, select: { ownerUserId: true } });
  if (thread === null) return { status: "gone" };
  const decision = message.optOutMatched ? PHRASE : given;
  const { label, confidence, suggested, returnDate, origin, call } = decision;
  const { workspaceId } = currentTenant();
  const id = newId(ids.reply_classification);
  const row = { id, workspaceId, messageId, threadId, personId, label, confidence, origin };
  const { count } = await tenantClient.replyClassification.createMany({
    data: [
      {
        ...{ ...row, isSuggested: suggested, optOutDetected: label === "opt_out" },
        ...{ entities: { returnDate }, actionsTaken: plain(NOTHING) },
        decisionRecordId: call?.decisionRecordId ?? null,
        modelId: call?.modelId ?? null,
        promptVersion: call?.promptVersion ?? null,
      },
    ],
    skipDuplicates: true,
  });
  if (count === 0) return { status: "repeat" };
  const newest = await isNewest(personId, messageId);
  const labeled = (await tenantClient.replyLabel.count({ where: { messageId } })) > 0;
  const taken =
    newest && !labeled
      ? await applyReplyLabel(personId, {
          ...{ label, suggested, returnDate, threadId, ownerUserId: thread.ownerUserId },
          // The reply's own instant (the store's sent_at), never the classification's.
          repliedAt: sentAt,
        })
      : await optOutOnly(personId, label);
  const data = { actionsTaken: plain(taken) };
  await tenantClient.replyClassification.updateMany({ where: { id }, data });
  const classified = { classificationId: id, messageId, threadId, personId, label };
  await publish(
    outboxWriter(tenantClient, workspaceId),
    events["inbox.reply_classified"],
    classified,
  );
  return { status: "classified", origin: decision.origin, newest };
}

/**
 * An older reply, or one its thread's owner labeled first, acts on nothing, but an opt-out
 * suppresses wherever it is found (F12 R2; RB-13.2.2: when in doubt, suppress); the owner's label of
 * an older reply too (domain/labels/label.ts).
 */
export async function optOutOnly(
  personId: string,
  label: ReplyActionLabel,
): Promise<ReplyActionsTaken> {
  if (label !== "opt_out") return NOTHING;
  await addOptOut(personId, REPLY_OPT_OUT);
  return OPTED_OUT;
}

/**
 * Whether the message is the person's newest reply, in any of their threads: by sent_at, then id.
 * The thread owner's label asks it too (domain/labels/label.ts).
 */
export async function isNewest(personId: string, messageId: string): Promise<boolean> {
  const threads = await tenantClient.thread.findMany({ where: { personId }, select: { id: true } });
  const newest = await tenantClient.message.findFirst({
    where: { threadId: { in: threads.map(({ id }) => id) }, direction: "in" },
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  return newest?.id === messageId;
}

const plain = ({ actions, enrollmentIds }: ReplyActionsTaken) => ({
  actions: [...actions],
  enrollmentIds: [...enrollmentIds],
});
