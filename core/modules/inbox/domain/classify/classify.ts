// A reply's classification (README.md "The classifier"; docs/flows.md "A reply classified"), what the
// workflow's activities call once the store's run has held the person's steps. The message, its
// phrase match and its thread's last CLASSIFY_THREAD_MESSAGES messages in one tenant run, a row
// already written ending the run there; a phrase decides opt_out with no model; else
// inbox.classify-reply, outside any run, on the texts masked (mask.ts), an answer under
// INBOX_CLASSIFY_SUGGEST_BELOW (settings.ts) suggested and a return date out of its range dropped;
// a failed answer, the fallback; then the row and campaigns' action in a last run (write.ts). The
// LLM port's codes are thrown, for Temporal to retry the activity; past its attempts the workflow
// writes the fallback (classifyFallback). Nothing here logs: no text leaves in a log line, an error
// or the answer.
import { agentModel, type CallOptions, callAgent, registeredAgentTasks } from "@whytide/ai";
import { errors as contactsErrors, getPerson } from "@whytide/contacts";
import type { TenantClient } from "@whytide/db";
import { type ActivityContext, AppError, isAppError } from "@whytide/platform";
import { findUser } from "@whytide/tenancy";
import type { classifyReplyTask } from "../../agents/classify-reply/task.ts";
import { errors } from "../../errors.ts";
import { CLASSIFY_REPLY, type ClassifyReplyInput } from "../../schemas/classify.ts";
import { settings } from "../../settings.ts";
import {
  CLASSIFY_TEXT_MAX,
  CLASSIFY_THREAD_MESSAGES,
  MS_PER_DAY,
  RETURN_DATE_MAX_DAYS,
} from "./constants.ts";
import { masker } from "./mask.ts";
import {
  type Classified,
  type ClassifyRequest,
  type Decision,
  fallback,
  PHRASE,
  writeClassification,
} from "./write.ts";

export type { Classified, ClassifyRequest };
export type ClassifyContext = Pick<ActivityContext<TenantClient>, "workspaceId" | "tenant"> & {
  readonly call?: CallOptions;
};
/** What the model reads, before the mask: the reply, its thread's earlier messages and the names. */
type Read = {
  readonly sentAt: Date;
  readonly body: string;
  readonly earlier: readonly { direction: "in" | "out"; sentAt: Date; body: string }[];
  readonly ownerUserId: string;
  readonly names: readonly (string | null)[];
};

/** The reply classified and acted on; or a repeat; or gone, the message or the person erased. */
export async function classifyReply(
  context: ClassifyContext,
  request: ClassifyRequest,
): Promise<Classified> {
  const read = await context.tenant((tx) => readReply(tx, request));
  if (read === "repeat" || read === "gone") return { status: read };
  const decision = read === "phrase" ? PHRASE : await decide(context, request, read);
  return context.tenant(() => writeClassification(request, decision));
}

/** Past the classifier's attempts: the fallback, other and suggested; a phrase's opt_out still wins. */
export function classifyFallback(
  context: ClassifyContext,
  request: ClassifyRequest,
): Promise<Classified> {
  return context.tenant(() => writeClassification(request, fallback(null)));
}

async function readReply(
  tx: TenantClient,
  { messageId, personId }: ClassifyRequest,
): Promise<Read | "phrase" | "repeat" | "gone"> {
  const message = await tx.message.findFirst({
    where: { id: messageId, personId, direction: "in" },
    select: { threadId: true, sentAt: true, body: true, optOutMatched: true },
  });
  if (message === null) return "gone";
  if ((await tx.replyClassification.count({ where: { messageId } })) > 0) return "repeat";
  if (message.optOutMatched) return "phrase";
  const { threadId, sentAt, body } = message;
  const thread = await tx.thread.findFirst({ where: { id: threadId } });
  const person = await getPerson(personId).catch((error: unknown) => {
    if (isAppError(error) && error.code === contactsErrors.person_not_found) return null;
    throw error;
  });
  if (thread === null || person === null) return "gone";
  // A reply from the inbox refused, failed or still sending was never in the conversation.
  const earlier = await tx.message.findMany({
    where: {
      ...{ threadId, id: { not: messageId }, sentAt: { lte: sentAt } },
      OR: [{ sendStatus: null }, { sendStatus: "sent" }],
    },
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
    take: CLASSIFY_THREAD_MESSAGES,
    select: { direction: true, sentAt: true, body: true },
  });
  const names = [person.firstName, person.lastName];
  return { sentAt, body, earlier: earlier.reverse(), ownerUserId: thread.ownerUserId, names };
}

/** The model's label, outside any run, on the masked texts; the fallback when its answers fail. */
async function decide(
  context: ClassifyContext,
  request: ClassifyRequest,
  read: Read,
): Promise<Decision> {
  const owner = await findUser(read.ownerUserId);
  const mask = masker([...read.names, owner?.displayName]);
  const input: ClassifyReplyInput = {
    thread: read.earlier.map(({ direction, sentAt, body }) => ({
      from: direction === "in" ? "lead" : "seller",
      day: dayOf(sentAt),
      text: mask(body).slice(0, CLASSIFY_TEXT_MAX.thread),
    })),
    reply: { day: dayOf(read.sentAt), text: mask(read.body).slice(0, CLASSIFY_TEXT_MAX.reply) },
  };
  const task = registeredTask();
  const { workspaceId } = context;
  const ask = { workspaceId, subjectRef: request.personId, input };
  const result = await callAgent(task, ask, context.call);
  const { modelId } = await agentModel(task);
  const { promptVersion } = task;
  const call = { decisionRecordId: result.decisionRecordId, modelId, promptVersion };
  if (result.status === "ai_failed") return fallback(call);
  const { label, confidence, returnDate } = result.output;
  const kept = label === "out_of_office" ? inRange(returnDate, read.sentAt) : null;
  const suggested = confidence < settings.INBOX_CLASSIFY_SUGGEST_BELOW;
  return { label, confidence, suggested, returnDate: kept, origin: "model", call };
}

const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** The return date, when it is a real day from the reply's day to RETURN_DATE_MAX_DAYS after it. */
function inRange(date: string | null, repliedAt: Date): string | null {
  if (date === null) return null;
  const at = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(at.getTime()) || !at.toISOString().startsWith(date)) return null;
  const first = Date.parse(`${dayOf(repliedAt)}T00:00:00Z`);
  const last = first + RETURN_DATE_MAX_DAYS * MS_PER_DAY;
  return at.getTime() >= first && at.getTime() <= last ? date : null;
}

/** The classifier's task, as the host's loadAgentTasks() registered it: classifier_agent_not_loaded. */
function registeredTask(): typeof classifyReplyTask {
  const task = registeredAgentTasks().get(CLASSIFY_REPLY);
  if (task === undefined) throw new AppError(errors.classifier_agent_not_loaded);
  return task as unknown as typeof classifyReplyTask;
}
