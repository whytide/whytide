// The module's workflows and their activities, which the worker host registers
// (core/apps/worker/README.md "Modules"), each started by a subscriber (events.ts):
// - inbox_store_message (README.md "The store", "The platform's own messages"), one message the
//   receiver kept, runs inbox_store, kind `provider` since it reads the files port. The file is read
//   outside any run; an inbound message's hold and store, or the account's own message's store, are
//   one tenant run; the file is deleted once that run committed. Ids in, ids and booleans out: the
//   text stays in the file until the store, then in messages.body only.
// - inbox_reply_mail (README.md "The reply mail"), one stored reply, runs inbox_mail_reply, kind
//   `provider` since it sends through the app-mail port (domain/mail.ts). Ids in, a code out.
// And onWorkerStart, which keeps the host's logger for campaigns.step_sent's subscriber.
import { json } from "node:stream/consumers";
import type { TenantClient } from "@whytide/db";
import { type MessageFile, messageFile } from "@whytide/linkedin";
import {
  type ActivityContext,
  AppError,
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineWorkflows,
  isAppError,
  type Logger,
  workflowInput,
} from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import { z } from "zod";
import { type MailResult, mailReply } from "../domain/mail.ts";
import { FILE_KEY_MAX, ID_MAX } from "../domain/store/constants.ts";
import { ECHO_UNSTORED, storeEcho } from "../domain/store/echo.ts";
import { useSentLog } from "../domain/store/sent.ts";
import { type StoreResult, storeInbound } from "../domain/store/store.ts";
import { errors } from "../errors.ts";

const id = z.string().min(1).max(ID_MAX);
const storeInput = workflowInput.extend({
  senderAccountId: id,
  personId: id,
  direction: z.enum(["in", "out"]),
  /** The message's file, its whole key under the workspace's raw/, which linkedin's event names. */
  fileKey: z.string().min(1).max(FILE_KEY_MAX),
});
export type StoreInput = z.output<typeof storeInput>;
/** One stored reply, by its message: inbox.reply_received's. */
const mailInput = workflowInput.extend({ messageId: id });
export type MailInput = z.output<typeof mailInput>;
/** A file with nothing to store: gone (raw/'s 72 hours), or not a message file of this event. */
type Unread = "missing" | "invalid";

/** The file parsed, or what kept it from parsing: "missing" or "invalid". A store's failure throws. */
async function readFile(workspaceId: string, input: StoreInput): Promise<MessageFile | Unread> {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  let body: unknown;
  try {
    body = await json((await files.get({ workspaceId, key: input.fileKey })).body);
  } catch (error) {
    const code = isAppError(error) ? error.code : undefined;
    if (code === filesPort.errors.files_not_found) return "missing";
    // A key outside the workspace's folder, or a body that is not JSON: nothing to store.
    if (code === filesPort.errors.files_key_outside_workspace || error instanceof SyntaxError) {
      return "invalid";
    }
    throw error;
  }
  const parsed = messageFile.safeParse(body);
  // The event's direction and the file's must agree: never the account's own text as a reply.
  const fromAccount = input.direction === "out";
  return parsed.success && parsed.data.fromAccount === fromAccount ? parsed.data : "invalid";
}

/**
 * The store of one message, then its file deleted: an inbound one is held and stored in one run
 * (domain/store/store.ts); the account's own is stored in one run, the tester's typed message with
 * its touch, the platform's stored once (domain/store/echo.ts). A missing file stores nothing, an
 * inbound one's holds all the same; an invalid one keeps the file and fails inbox_file_invalid,
 * after an inbound one's hold.
 */
export async function storeMessage(
  context: Pick<ActivityContext<TenantClient>, "workspaceId" | "tenant">,
  input: StoreInput,
): Promise<StoreResult> {
  const { workspaceId } = context;
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  const remove = () => files.delete({ workspaceId, key: input.fileKey });
  const read = await readFile(workspaceId, input);
  const file = typeof read === "string" ? null : read;
  const { personId, senderAccountId } = input;
  const now = new Date();
  if (input.direction === "out") {
    // An invalid file stays for the runbook; raw/'s 72 hours expire it.
    if (read === "invalid") throw new AppError(errors.inbox_file_invalid);
    if (file === null) return ECHO_UNSTORED;
    const result = await context.tenant(() => storeEcho({ personId, senderAccountId, file, now }));
    await remove();
    return result;
  }
  const result = await context.tenant(() => storeInbound({ personId, senderAccountId, file, now }));
  // The hold has committed. An invalid file stays for the runbook; raw/'s 72 hours expire it.
  if (read === "invalid") throw new AppError(errors.inbox_file_invalid);
  if (read !== "missing") await remove();
  return result;
}

export const workflows = defineWorkflows({
  inbox_reply_mail: { input: mailInput, taskQueue: DEFAULT_TASK_QUEUE },
  inbox_store_message: { input: storeInput, taskQueue: DEFAULT_TASK_QUEUE },
});

export const activities = {
  inbox_mail_reply: defineActivity<typeof mailInput, MailResult, TenantClient>({
    kind: "provider",
    input: mailInput,
    run: (input, context) => mailReply(context, input.messageId),
  }),
  inbox_store: defineActivity<typeof storeInput, StoreResult, TenantClient>({
    kind: "provider",
    input: storeInput,
    run: (input, context) => storeMessage(context, input),
  }),
};

/** Before the worker polls: the host's logger, for the step's subscriber's unmatched line. */
export async function onWorkerStart(context: { readonly log: Logger }): Promise<void> {
  useSentLog(context.log);
}
