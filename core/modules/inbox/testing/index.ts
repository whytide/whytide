// inbox's test helpers (README.md "Testing"), `@whytide/inbox/testing`, in test files only: a thread,
// a message and a reply's label written straight to the tables, as the store and the label leave
// them, for inbox's, privacy's, the later inbox tasks' and the web's e2e tests; on the client given,
// else on the one useInboxClient set, else on asRole("app") of @whytide/db/testing, so the test file
// calls withTestDb() first. useInboxExportClient(asRole("app")) points the reply golden set's own
// runs, the route's and the command's, at the test file's schema; undefined puts the process's back.
import type { TenantClient } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { newId } from "@whytide/platform";
import type { ReplyLabelValue } from "../domain/labels/constants.ts";
import { INBOX_CHANNEL } from "../domain/store/constants.ts";
import { ids } from "../ids.ts";

export { useClient as useInboxExportClient } from "../domain/export/client.ts";

type Client = Pick<TenantClient, "thread" | "message" | "replyLabel">;
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

/** A reply's label, as the label leaves it; labeled now unless given. Its id. */
export async function createLabel(
  input: {
    readonly workspaceId: string;
    readonly messageId: string;
    readonly label: ReplyLabelValue;
    readonly labeledBy: string;
    readonly labeledAt?: Date;
  },
  client: Client = given ?? asRole("app"),
): Promise<string> {
  const id = newId(ids.reply_label);
  const { labeledAt = new Date(), ...label } = input;
  await client.replyLabel.create({ data: { id, ...label, labeledAt } });
  return id;
}
