// writeReply (README.md "The reply writer", docs/flows.md "A reply drafted"; inbox-reply-draft): what
// inbox's reply draft activity calls, outside any run, with the thread's messages and the member's
// brief, which it read from its own tables (messaging never imports inbox). The member's membership
// outside a run, the dossier as that member, the person's colleagues in a run of their own; then one
// call of messaging.write-reply, its answer checked by the reply's gates and, on an issue, written
// again once with the issues in <failures>. It answers the text, ready, with the call's model, prompt
// version and decision record, or a failure code; it writes no table of its own. Nothing here logs:
// no text, fact or name leaves in a log line, a span or an error. The LLM port's codes are thrown, for
// Temporal to retry the activity.
import { callAgent } from "@whytide/ai";
import { isAppError, type Principal } from "@whytide/platform";
import { resolveMembership } from "@whytide/tenancy";
import { z } from "zod";
import type { writeReplyTask } from "../../agents/write-reply/task.ts";
import { errors } from "../../errors.ts";
import { WRITE_REPLY } from "../../schemas/reply.ts";
import type { GateIssue } from "../../schemas/writer.ts";
import { buildDossier } from "../dossier/build.ts";
import { writerBlocks } from "../drafts/blocks.ts";
import { textLanguage } from "../drafts/language.ts";
import { parse } from "../drafts/store.ts";
import { type DraftContext, modelOf, readColleagues, registeredTask } from "../drafts/write.ts";
import { MESSAGE_HARD_LIMIT, TEXT_MIN_CHARACTERS } from "../gates/constants.ts";
import { issuesOf, textGates } from "../gates/index.ts";
import { replyChat } from "./chat.ts";
import { REPLY_AUTHORS, REPLY_BRIEF_MAX, REPLY_REWRITES } from "./constants.ts";

/** Why a reply was not drafted: a code, never a text. */
export type ReplyFailureCode =
  | "ai_failed"
  | "gates_failed"
  | "conversation_empty"
  | "dossier_lead_not_found"
  | "draft_requester_not_member";
export type ReplyWritten =
  | {
      readonly status: "ready";
      readonly text: string;
      readonly modelId: string;
      readonly promptVersion: number;
      readonly decisionRecordId: string;
    }
  | {
      readonly status: "failed";
      readonly code: ReplyFailureCode;
      readonly decisionRecordId: string | null;
    };

const id = z.string().min(1).max(64);
const writeReplyRequest = z.object({
  personId: id,
  /** The member who asked, as whom the dossier is built. */
  userId: id,
  /** The thread's messages, oldest first; the latest are read (chat.ts). */
  conversation: z.array(z.object({ from: z.enum(REPLY_AUTHORS), at: z.date(), text: z.string() })),
  brief: z.string().max(REPLY_BRIEF_MAX).nullable(),
  /** The ready draft the request replaces, for <replaced>; null for none. */
  replaced: z.string().nullable(),
  /** The caller's id of the request, inbox's draft id, for <request>: a new one asks the model again. */
  requestId: id,
});
export type WriteReplyRequest = z.input<typeof writeReplyRequest>;

/** The reply drafted for the member, or why not. messaging_input_invalid, writer_agent_not_loaded. */
export async function writeReply(
  request: WriteReplyRequest,
  context: DraftContext,
): Promise<ReplyWritten> {
  const { personId, userId, conversation, brief, replaced, requestId } = parse(
    writeReplyRequest,
    request,
  );
  const failed = (code: ReplyFailureCode, decisionRecordId: string | null = null) =>
    ({ status: "failed", code, decisionRecordId }) as const;
  const task = registeredTask<typeof writeReplyTask>(WRITE_REPLY);
  const chat = replyChat(conversation);
  if (chat.length === 0) return failed("conversation_empty");
  const { workspaceId } = context;
  const membership = await resolveMembership({ userId, workspaceIdOrSlug: workspaceId });
  if (membership === null) return failed("draft_requester_not_member");
  const principal: Principal = {
    ...{ userId, actorType: "human", authMethod: "session", membershipId: membership.id },
    ...{ workspaceId, role: membership.role, scopes: [] },
  };
  const dossier = await buildDossier({ workspaceId, principal }, personId).catch((error) => {
    if (isAppError(error) && error.code === errors.dossier_lead_not_found) return null;
    throw error;
  });
  if (dossier === null) return failed("dossier_lead_not_found");
  const colleagues = await readColleagues(context, personId);
  if (colleagues === null) return failed("dossier_lead_not_found");

  // The lead's own words decide the language; a thread of the seller's alone, its words.
  const leads = chat.filter(({ from }) => from === "lead");
  const language = textLanguage((leads.length > 0 ? leads : chat).map(({ text }) => text));
  const said = brief?.trim() || null;
  const channel = {
    channel: "linkedin_message" as const,
    maxCharacters: MESSAGE_HARD_LIMIT,
    language,
  };
  const limits = { min: TEXT_MIN_CHARACTERS, max: MESSAGE_HARD_LIMIT };
  // A name, number or date of the brief or the conversation is no invention.
  const also = [...(said === null ? [] : [said]), ...chat.map(({ text }) => text)];
  const grounding = { also, skipNames: language !== "english" };
  const blocks = writerBlocks(dossier);
  const { modelId, promptVersion } = await modelOf(task);
  const failures: GateIssue[][] = [];
  for (;;) {
    const thread = { conversation: chat, brief: said };
    const input = { channel, ...blocks, ...thread, failures, replaced, request: requestId };
    const result = await callAgent(
      task,
      { workspaceId, subjectRef: personId, input },
      context.call,
    );
    const { decisionRecordId } = result;
    if (result.status === "ai_failed") return failed("ai_failed", decisionRecordId);
    const text = result.output.text.trim();
    const issues = issuesOf(textGates(text, { limits, colleagues, dossier, grounding }));
    if (issues.length === 0) {
      return { status: "ready", text, modelId, promptVersion, decisionRecordId };
    }
    if (failures.length === REPLY_REWRITES) return failed("gates_failed", decisionRecordId);
    failures.push(issues);
  }
}
