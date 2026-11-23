// The module's workflows and their activities, which the worker host registers
// (core/apps/worker/README.md "Modules"), each started by a subscriber (events.ts):
// - inbox_store_message (README.md "The store", "The platform's own messages"), one message the
//   receiver kept, runs inbox_store, kind `provider` since it reads the files port. The file is read
//   outside any run; an inbound message's hold and store, or the account's own message's store, are
//   one tenant run; the file is deleted once that run committed. Ids in, ids and booleans out: the
//   text stays in the file until the store, then in messages.body only.
// - inbox_reply_mail (README.md "The reply mail"), one stored reply, runs inbox_mail_reply, kind
//   `provider` since it sends through the app-mail port (domain/mail.ts), a mail the server refused
//   for good, or the port's input refused, never retried (gamma-p0-085). Ids in, a code out.
// - inbox_send_reply (README.md "Replies from the inbox"), one member's reply from the inbox, runs
//   inbox_reply_begin, then linkedin's linkedin_check_reply and send activity by name, then
//   inbox_reply_settle, and linkedin_check_sent after an unknown outcome (reply.ts); both kind
//   `provider`, since they write and delete the request file through the files port. Ids in, ids,
//   statuses and codes out.
// - inbox_draft_reply (README.md "The reply draft"), one member's reply draft, runs
//   inbox_write_reply_draft, kind `ai` (domain/reply-draft/write.ts), then past its attempts
//   inbox_reply_draft_failed with the failure's code; inbox_reply_draft_sweep, global, every 15
//   minutes, fails the drafts no run will write, workspace by workspace. Ids in, statuses and counts
//   out: the brief and the conversation reach the writer from the tables.
// - inbox_classify_reply (README.md "The classifier"), one stored reply, runs inbox_classify, kind
//   `ai` (domain/classify/classify.ts), then past its attempts inbox_classify_failed, which stores the
//   fallback. Ids in, a status, the label's origin and whether the reply was the newest out: the
//   texts reach the classifier from the tables.
// And onWorkerStart, which keeps the host's logger for campaigns.step_sent's subscriber and the
// reply mail's line, and gives enrichment's `reply` source its reader (gamma-en-085).
import { json } from "node:stream/consumers";
import type { TenantClient } from "@whytide/db";
import { useAddressesGiven } from "@whytide/enrichment";
import { type MessageFile, messageFile } from "@whytide/linkedin";
import {
  type ActivityContext,
  AppError,
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineSchedules,
  defineWorkflows,
  globalWorkflowInput,
  isAppError,
  type Logger,
  workflowInput,
} from "@whytide/platform";
import { appMailPort, filesConfig, filesPort, getAdapter } from "@whytide/providers";
import { listWorkspaceIds } from "@whytide/tenancy";
import { z } from "zod";
import { addressesGivenBy } from "../domain/addresses/given.ts";
import { type Classified, classifyFallback, classifyReply } from "../domain/classify/classify.ts";
import { type MailResult, mailReply, useMailLog } from "../domain/mail.ts";
import type { Settled } from "../domain/reply/settle.ts";
import { CODE_PATTERN } from "../domain/reply-draft/constants.ts";
import {
  type DraftRun,
  markReplyDraftFailed,
  sweepStuckReplyDrafts,
  writeReplyDraft,
} from "../domain/reply-draft/write.ts";
import { FILE_KEY_MAX, ID_MAX } from "../domain/store/constants.ts";
import { ECHO_UNSTORED, storeEcho } from "../domain/store/echo.ts";
import { useSentLog } from "../domain/store/sent.ts";
import { type StoreResult, storeInbound } from "../domain/store/store.ts";
import { errors } from "../errors.ts";
import { DRAFT_SWEEP } from "./constants.ts";
import {
  type Begun,
  beginReply,
  type ReplyInput,
  replyInput,
  settleInput,
  settleReplyRun,
} from "./reply.ts";

export type { ReplyInput };

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
/** One stored reply, by its message, its thread and its person: inbox.reply_received's. */
const classifyInput = workflowInput.extend({ messageId: id, threadId: id, personId: id });
export type ClassifyInput = z.output<typeof classifyInput>;
/** One reply draft, by its id: inbox.reply_draft_requested's. */
const draftInput = workflowInput.extend({ draftId: id });
export type DraftInput = z.output<typeof draftInput>;
/** The draft failed past the writer's attempts, with the failure's code: a code, never a text. */
const draftFailedInput = draftInput.extend({ code: z.string().regex(CODE_PATTERN) });
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
  inbox_classify_reply: { input: classifyInput, taskQueue: DEFAULT_TASK_QUEUE },
  inbox_draft_reply: { input: draftInput, taskQueue: DEFAULT_TASK_QUEUE },
  inbox_reply_draft_sweep: {
    input: globalWorkflowInput,
    taskQueue: DEFAULT_TASK_QUEUE,
    scope: "global",
  },
  inbox_reply_mail: { input: mailInput, taskQueue: DEFAULT_TASK_QUEUE },
  inbox_send_reply: { input: replyInput, taskQueue: DEFAULT_TASK_QUEUE },
  inbox_store_message: { input: storeInput, taskQueue: DEFAULT_TASK_QUEUE },
});

export const activities = {
  /** Classifies the reply and acts on its label (README.md "The classifier"). */
  inbox_classify: defineActivity<typeof classifyInput, Classified, TenantClient>({
    kind: "ai",
    input: classifyInput,
    run: (input, context) => classifyReply(context, input),
  }),
  /** Past the classifier's attempts: the fallback, other and suggested, stored and acted on. */
  inbox_classify_failed: defineActivity<typeof classifyInput, Classified, TenantClient>({
    kind: "db",
    input: classifyInput,
    run: (input, context) => classifyFallback(context, input),
  }),
  /** Every workspace's id, from tenancy, and nothing else: the drafts' sweep's fan-out. */
  inbox_list_workspaces: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: async () => ({ workspaceIds: await listWorkspaceIds() }),
  }),
  inbox_mail_reply: defineActivity<typeof mailInput, MailResult, TenantClient>({
    kind: "provider",
    notRetried: [appMailPort.errors.mail_rejected, appMailPort.codes.input],
    input: mailInput,
    run: (input, context) => mailReply(context, input.messageId),
  }),
  inbox_reply_begin: defineActivity<typeof replyInput, Begun, TenantClient>({
    kind: "provider",
    input: replyInput,
    run: (input, context) => beginReply(context, input),
  }),
  inbox_reply_draft_failed: defineActivity<typeof draftFailedInput, void, TenantClient>({
    kind: "db",
    input: draftFailedInput,
    run: (input, context) => context.tenant(() => markReplyDraftFailed(input.draftId, input.code)),
  }),
  inbox_reply_settle: defineActivity<typeof settleInput, Settled, TenantClient>({
    kind: "provider",
    input: settleInput,
    run: (input, context) => settleReplyRun(context, input),
  }),
  inbox_store: defineActivity<typeof storeInput, StoreResult, TenantClient>({
    kind: "provider",
    input: storeInput,
    run: (input, context) => storeMessage(context, input),
  }),
  /** The workspace's drafts stuck in `drafting`, failed, draft_stuck: how many. */
  inbox_sweep_reply_drafts: defineActivity({
    kind: "db",
    input: workflowInput,
    run: (_input, context: ActivityContext<TenantClient>) =>
      context.tenant(() => sweepStuckReplyDrafts()),
  }),
  /** Writes the draft from its thread and its brief, and stores it (README.md "The reply draft"). */
  inbox_write_reply_draft: defineActivity<typeof draftInput, DraftRun, TenantClient>({
    kind: "ai",
    input: draftInput,
    run: (input, context) => writeReplyDraft(context, input.draftId),
  }),
};

/** Every 15 minutes: the sweep of the reply drafts no run will write (docs/runbook.md). */
export const schedules = defineSchedules([
  {
    id: "reply_draft_sweep",
    workflow: "inbox_reply_draft_sweep",
    spec: { intervals: [{ every: DRAFT_SWEEP.every }] },
    input: {},
  },
]);

/**
 * Before the worker polls: the host's logger, for the step's subscriber's unmatched line and the
 * reply mail's owner_unavailable line.
 */
export async function onWorkerStart(context: { readonly log: Logger }): Promise<void> {
  useSentLog(context.log);
  useMailLog(context.log);
  // enrichment's `reply` email source reads the addresses a person gave (gamma-en-085).
  useAddressesGiven(addressesGivenBy);
}
