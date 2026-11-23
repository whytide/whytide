// A reply draft's request and read (README.md "The reply draft"; inbox-reply-draft), in the request's
// tenant run. Both on the caller's own thread only, else thread_not_found, as another workspace's or
// none. The request checks as the reply's press does: the channel sending, else
// reply_channel_unavailable; the brief, trimmed, within REPLY_BRIEF_MAX, else reply_brief_too_long;
// the person's lead locked, then contacts' suppression, else person_suppressed with its reason. Under
// that lock it answers a draft still drafting as it is, with no second run; else the thread's draft is
// replaced by a new one, drafting, with the ready text it replaces, and inbox.reply_draft_requested
// in the same run, whose subscriber starts inbox_draft_reply. No model is called here.
import { errors as contactsErrors, lockLeadStatus, suppressionOf } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId, publish } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { ids } from "../../ids.ts";
import { type ReplyState, replyStateOf } from "../reply/channel.ts";
import { now as clock } from "../reply/clock.ts";
import { REPLY_BRIEF_MAX, type ReplyDraftStatus } from "./constants.ts";

/** A thread's draft as the routes answer it: never the brief, the model or the record. */
export type ReplyDraftView = {
  readonly status: ReplyDraftStatus | "none";
  readonly text: string | null;
  readonly error: string | null;
  readonly requestedAt: string | null;
};
type Row = {
  status: ReplyDraftStatus;
  text: string | null;
  errorCode: string | null;
  requestedAt: Date;
};

const THREAD = {
  id: true,
  channel: true,
  senderAccountId: true,
  ownerUserId: true,
  personId: true,
};
const NONE: ReplyDraftView = { status: "none", text: null, error: null, requestedAt: null };
const view = (row: Row | null): ReplyDraftView =>
  row === null
    ? NONE
    : {
        status: row.status,
        text: row.text,
        error: row.errorCode,
        requestedAt: row.requestedAt.toISOString(),
      };

/** The caller's own thread with its reply state; thread_not_found otherwise. */
async function ownThread(threadId: string) {
  const { principal } = currentTenant();
  // Prisma drops an undefined value from a where: unchecked, that would be any thread. The
  // caller's own only, as every read of the inbox (gamma-p6-060): another member's is not found.
  const where = { id: threadId, ownerUserId: principal.userId };
  const thread =
    typeof threadId === "string" && threadId !== ""
      ? await tenantClient.thread.findFirst({ where, select: THREAD })
      : null;
  if (thread === null) throw new AppError(errors.thread_not_found);
  const state: ReplyState = await replyStateOf(thread, principal.userId);
  if (!state.own) throw new AppError(errors.thread_not_found);
  return { thread, state };
}

/** The thread's draft, `none` without one. */
export async function readReplyDraft(threadId: string): Promise<ReplyDraftView> {
  const { thread } = await ownThread(threadId);
  return view(await tenantClient.replyDraft.findFirst({ where: { threadId: thread.id } }));
}

/** The thread's draft drafting: the one under way, or a new one and its event. */
export async function requestReplyDraft(
  threadId: string,
  brief: string | undefined,
): Promise<ReplyDraftView> {
  const { workspaceId, principal } = currentTenant();
  const { thread, state } = await ownThread(threadId);
  if (!state.channelAvailable) throw new AppError(errors.reply_channel_unavailable);
  const said = typeof brief === "string" ? brief.trim() : "";
  if (said.length > REPLY_BRIEF_MAX) {
    throw new AppError(errors.reply_brief_too_long, { details: { max: REPLY_BRIEF_MAX } });
  }
  // The lead's lock serializes two requests of the thread, as it does the reply's press.
  await lockLeadStatus(thread.personId);
  const suppression = await suppressionOf(thread.personId, { newEnrollment: false });
  if (suppression.suppressed) {
    const details = { reason: suppression.reason };
    throw new AppError(contactsErrors.person_suppressed, { details });
  }
  const current = await tenantClient.replyDraft.findFirst({ where: { threadId: thread.id } });
  if (current?.status === "drafting") return view(current);
  if (current !== null) await tenantClient.replyDraft.delete({ where: { id: current.id } });
  const draftId = newId(ids.reply_draft);
  const row = await tenantClient.replyDraft.create({
    data: {
      ...{ id: draftId, workspaceId, threadId: thread.id, requestedBy: principal.userId },
      ...{ brief: said === "" ? null : said, requestedAt: clock() },
      replacedText: current?.status === "ready" ? current.text : null,
    },
  });
  await publish(outboxWriter(tenantClient, workspaceId), events["inbox.reply_draft_requested"], {
    draftId,
  });
  return view(row);
}
