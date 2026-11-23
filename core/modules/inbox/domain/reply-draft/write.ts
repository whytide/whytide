// A reply draft's run (README.md "The reply draft"; docs/flows.md "A reply drafted"), what the
// workflow's activities call. The draft, its person and its thread's latest REPLY_CHAT_MAX messages
// in one tenant run, the person's and the account's sent ones only (a reply from here refused,
// failed or still sending was never in the conversation); then messaging's writeReply outside any
// run, which calls the model; then the draft's end in a last run, written only while it is drafting
// still: one the sweep failed, or a later request replaced, keeps its state, and the late answer is
// dropped. The brief and the messages reach the writer from the tables, never from an input, and the
// answer is a status alone. The failure mark and the sweep run in the caller's tenant run.
import { tenantClient } from "@whytide/db";
import {
  type ChatMessage,
  REPLY_CHAT_MAX,
  type ReplyWritten,
  writeReply,
} from "@whytide/messaging";
import {
  DRAFT_STUCK,
  MS_PER_MINUTE,
  REPLY_DRAFT_STUCK_MINUTES,
  type ReplyDraftStatus,
} from "./constants.ts";

type Context = Parameters<typeof writeReply>[1];
/** The draft's state once the run ended; `gone` once a later request replaced it, or an erasure. */
export type DraftRun = { readonly status: ReplyDraftStatus | "gone" };

/** Writes the draft while it is drafting, and answers its state as stored. */
export async function writeReplyDraft(context: Context, draftId: string): Promise<DraftRun> {
  const read = await context.tenant(async (tx) => {
    const draft = await tx.replyDraft.findFirst({ where: { id: draftId } });
    if (draft === null || draft.status !== "drafting") return draft;
    // No relation in a tenant query (the scoped client refuses one): the thread on its own.
    const where = { id: draft.threadId };
    const thread = await tx.thread.findFirstOrThrow({ where, select: { personId: true } });
    const rows = await tx.message.findMany({
      where: { threadId: draft.threadId, OR: [{ sendStatus: null }, { sendStatus: "sent" }] },
      orderBy: [{ sentAt: "desc" }, { id: "desc" }],
      take: REPLY_CHAT_MAX,
      select: { direction: true, sentAt: true, body: true },
    });
    const conversation = rows.reverse().map(
      ({ direction, sentAt, body }): ChatMessage => ({
        ...{ from: direction === "in" ? "lead" : "seller", at: sentAt, text: body },
      }),
    );
    return { ...draft, personId: thread.personId, conversation };
  });
  if (read === null) return { status: "gone" };
  if (!("conversation" in read)) return { status: read.status };
  const { personId, requestedBy: userId, brief, replacedText: replaced, conversation } = read;
  // The draft's id is the writer's <request>: a new draft, Try again among them, is a new model call.
  const request = { personId, userId, conversation, brief, replaced, requestId: draftId };
  const written = await writeReply(request, context);
  return context.tenant(() => end(draftId, written));
}

/** The writer's answer on the draft while it is drafting; else the draft's state as stored. */
async function end(draftId: string, written: ReplyWritten): Promise<DraftRun> {
  const { decisionRecordId } = written;
  const data =
    written.status === "ready"
      ? { status: "ready" as const, text: written.text, decisionRecordId, ...modelOf(written) }
      : { status: "failed" as const, errorCode: written.code, decisionRecordId };
  const where = { id: draftId, status: "drafting" as const };
  const { count } = await tenantClient.replyDraft.updateMany({ where, data });
  if (count === 1) return { status: written.status };
  const select = { status: true } as const;
  const stored = await tenantClient.replyDraft.findFirst({ where: { id: draftId }, select });
  return { status: stored?.status ?? "gone" };
}
const modelOf = ({ modelId, promptVersion }: { modelId: string; promptVersion: number }) => ({
  modelId,
  promptVersion,
});

/** Once the writer failed past its attempts: the draft failed with the failure's code. */
export async function markReplyDraftFailed(draftId: string, code: string): Promise<void> {
  const where = { id: draftId, status: "drafting" as const };
  await tenantClient.replyDraft.updateMany({ where, data: { status: "failed", errorCode: code } });
}

/** Fails the workspace's drafts still drafting REPLY_DRAFT_STUCK_MINUTES after their request. */
export async function sweepStuckReplyDrafts(now: Date = new Date()): Promise<{ stuck: number }> {
  const before = new Date(now.getTime() - REPLY_DRAFT_STUCK_MINUTES * MS_PER_MINUTE);
  const where = { status: "drafting" as const, requestedAt: { lt: before } };
  const data = { status: "failed" as const, errorCode: DRAFT_STUCK };
  return { stuck: (await tenantClient.replyDraft.updateMany({ where, data })).count };
}
