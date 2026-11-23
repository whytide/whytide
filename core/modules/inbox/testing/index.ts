// inbox's test helpers (README.md "Testing"), `@whytide/inbox/testing`, in test files only: a thread,
// a message, a reply's label, a reply draft and a reply's classification written straight to the
// tables, as the store, the label, the draft's run and the classifier leave them, for inbox's, privacy's, the later inbox tasks' and the web's e2e tests; on the client given,
// else on the one useInboxClient set, else on asRole("app") of @whytide/db/testing, so the test file
// calls withTestDb() first. useInboxExportClient(asRole("app")) points the reply golden set's own
// runs, the route's and the command's, at the test file's schema; undefined puts the process's back.
// useReplyClock(() => date) sets the time a reply's route and settle read, as linkedin's useClock
// does its own (gamma-p4-060); undefined puts the system's back.
import type { ReplyActionLabel } from "@whytide/campaigns";
import type { TenantClient } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { newId } from "@whytide/platform";
import type { ReplyLabelValue } from "../domain/labels/constants.ts";
import { betaWord } from "../domain/labels/word.ts";
import type { ReplyDraftStatus } from "../domain/reply-draft/constants.ts";
import { INBOX_CHANNEL } from "../domain/store/constants.ts";
import { ids } from "../ids.ts";

export { useClient as useInboxExportClient } from "../domain/export/client.ts";
export { useClock as useReplyClock } from "../domain/reply/clock.ts";

type Client = Pick<
  TenantClient,
  "thread" | "message" | "replyLabel" | "replyDraft" | "replyClassification"
>;
let given: Client | undefined;

/** The client the factories write on when none is given; undefined restores asRole("app"). */
export function useInboxClient(client: Client | undefined): void {
  given = client;
}

/** A thread of the person; the account, the owner and the chat made up unless given. Its id. */
export async function createThread(
  input: {
    readonly workspaceId: string;
    readonly personId: string;
    readonly senderAccountId?: string;
    readonly ownerUserId?: string;
    readonly providerThreadRef?: string;
    readonly lastMessageAt?: Date;
  },
  client: Client = given ?? asRole("app"),
): Promise<string> {
  const id = newId(ids.thread);
  const {
    senderAccountId = "sac_test",
    ownerUserId = "usr_test",
    lastMessageAt = new Date(),
  } = input;
  await client.thread.create({
    data: {
      ...{ id, workspaceId: input.workspaceId, personId: input.personId, channel: INBOX_CHANNEL },
      ...{ senderAccountId, ownerUserId, lastMessageAt },
      providerThreadRef: input.providerThreadRef ?? `chat-${id}`,
    },
  });
  return id;
}

/**
 * A message in the thread: the person's (`in`, no `sent_by`) unless given `out`, the user's then
 * unless `sentBy` says the campaign's, approved at `approvedAt`; the text and the provider's ref
 * made up unless given. Its id.
 */
export async function createMessage(
  input: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly personId: string;
    readonly direction?: "in" | "out";
    readonly body?: string;
    readonly providerMessageRef?: string;
    readonly sentAt?: Date;
    readonly optOutMatched?: boolean;
    readonly sentBy?: "campaign" | "user";
    readonly approvedAt?: Date;
  },
  client: Client = given ?? asRole("app"),
): Promise<string> {
  const id = newId(ids.message);
  const { workspaceId, threadId, personId, direction = "in", sentAt = new Date() } = input;
  await client.message.create({
    data: {
      ...{ id, workspaceId, threadId, personId, direction, sentAt, receivedAt: sentAt },
      sentBy: direction === "in" ? null : (input.sentBy ?? "user"),
      approvedAt: input.approvedAt ?? null,
      body: input.body ?? "Thanks, next week works.",
      providerMessageRef: input.providerMessageRef ?? `message-${id}`,
      optOutMatched: input.optOutMatched ?? false,
    },
  });
  return id;
}

/**
 * A reply's label, as the label leaves it, with no action: the thread owner's class with beta's word
 * that follows it (gamma-p4-055), or beta's word alone, a row of beta's buttons; labeled now unless
 * given. Its id.
 */
export async function createLabel(
  input: {
    readonly workspaceId: string;
    readonly messageId: string;
    readonly labeledBy: string;
    readonly labeledAt?: Date;
  } & (
    | { readonly classLabel: ReplyActionLabel; readonly label?: ReplyLabelValue }
    | { readonly classLabel?: null; readonly label: ReplyLabelValue }
  ),
  client: Client = given ?? asRole("app"),
): Promise<string> {
  const id = newId(ids.reply_label);
  const { workspaceId, messageId, labeledBy, labeledAt = new Date() } = input;
  const classLabel = input.classLabel ?? null;
  const label = input.label ?? (classLabel === null ? undefined : betaWord(classLabel));
  if (label === undefined) throw new Error("createLabel: a label or a class");
  const row = { id, workspaceId, messageId, label, classLabel, labeledBy, labeledAt };
  await client.replyLabel.create({ data: row });
  return id;
}

/**
 * The thread's reply draft, as the draft's run leaves it: ready with a made-up text unless given
 * another status, failed with `write_failed` unless given a code; no brief and no text it replaces
 * unless given; requested now unless given. Its id. No event: a drafting one is run by the test.
 */
export async function createReplyDraft(
  input: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly requestedBy?: string;
    readonly status?: ReplyDraftStatus;
    readonly text?: string;
    readonly errorCode?: string;
    readonly brief?: string;
    readonly replacedText?: string;
    readonly requestedAt?: Date;
  },
  client: Client = given ?? asRole("app"),
): Promise<string> {
  const id = newId(ids.reply_draft);
  const { workspaceId, threadId, requestedBy = "usr_test", status = "ready" } = input;
  await client.replyDraft.create({
    data: {
      ...{ id, workspaceId, threadId, requestedBy, status },
      text: status === "ready" ? (input.text ?? "Thanks, Tuesday works for me.") : null,
      errorCode: status === "failed" ? (input.errorCode ?? "write_failed") : null,
      brief: input.brief ?? null,
      replacedText: input.replacedText ?? null,
      requestedAt: input.requestedAt ?? new Date(),
    },
  });
  return id;
}

/**
 * A reply's classification, as the classifier leaves it: the model's, with its call, sure, no return
 * date and nothing acted on, unless given; the label any text, so that a test reaches the CHECK. Its id.
 */
export async function createClassification(
  input: {
    readonly workspaceId: string;
    readonly messageId: string;
    readonly threadId: string;
    readonly personId: string;
    readonly label: string;
    readonly confidence?: number;
    readonly isSuggested?: boolean;
    readonly returnDate?: string | null;
    readonly origin?: "phrase" | "model" | "fallback";
  },
  client: Client = given ?? asRole("app"),
): Promise<string> {
  const id = newId(ids.reply_classification);
  const { confidence = 0.9, isSuggested = false, returnDate = null, origin = "model" } = input;
  const { workspaceId, messageId, threadId, personId, label } = input;
  const call = origin === "model" ? { decisionRecordId: "dec_test", modelId: "fake-model" } : {};
  await client.replyClassification.create({
    data: {
      ...{ id, workspaceId, messageId, threadId, personId, label, confidence, isSuggested },
      ...{ optOutDetected: label === "opt_out", entities: { returnDate }, origin, ...call },
      promptVersion: origin === "model" ? 1 : null,
      actionsTaken: { actions: [], enrollmentIds: [] },
    },
  });
  return id;
}
