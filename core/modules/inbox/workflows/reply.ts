// inbox_send_reply's activities' bodies (README.md "Replies from the inbox"; docs/flows.md "A reply
// from the inbox"), each a tenant run through domain/reply/ and the request file around it, never
// inside it: inbox_reply_begin, the checks again and linkedin's slot (begin.ts), then the request
// file written under the workspace's raw/, where linkedin's send activity reads the text, so it never
// enters a workflow's input, result or history; inbox_reply_settle, the row on linkedin's answer
// (settle.ts), then the file deleted once the reply settled. An outcome unknown keeps the file for
// linkedin_check_sent. `retry`: the file is there already, an earlier run's or attempt's, so the send
// activity checks before it calls.
import type { TenantClient } from "@whytide/db";
import { type ActivityContext, isAppError, workflowInput } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import { z } from "zod";
import { prepareReply } from "../domain/reply/begin.ts";
import { now } from "../domain/reply/clock.ts";
import {
  REQUEST_CONTENT_TYPE,
  REQUEST_FILE,
  REQUEST_FOLDER,
  type SendStatus,
} from "../domain/reply/constants.ts";
import { type Settled, settleReply } from "../domain/reply/settle.ts";
import { ID_MAX } from "../domain/store/constants.ts";

type Context = Pick<ActivityContext<TenantClient>, "workspaceId" | "tenant">;

const id = z.string().min(1).max(ID_MAX);
/** The longest code an answer carries: linkedin's and the port's are shorter. */
const CODE_MAX = 64;
const code = z.string().min(1).max(CODE_MAX);
/** One reply, by its message: inbox.reply_requested's. */
export const replyInput = workflowInput.extend({ messageId: id });
export type ReplyInput = z.output<typeof replyInput>;
/** linkedin's answer to the send or its check, as the workflow passes it on: codes, ids, instants. */
const answer = z.union([
  z.strictObject({ sent: z.literal(true), stepExecutionId: id }),
  z.strictObject({ outcome: z.enum(["sent", "not_sent"]), stepExecutionId: id }),
  z.strictObject({ refused: code, retryAt: z.iso.datetime().nullable() }),
  z.strictObject({ refused: code, retryAfterSec: z.number().nonnegative().optional() }),
]);
export const settleInput = replyInput.extend({
  accountId: id,
  reservationId: id,
  phase: z.enum(["read", "send", "check"]),
  answer: answer.nullable(),
  /** The send's code, which a check's "not sent" fails the reply with. */
  code: code.nullable(),
});
export type SettleInput = z.output<typeof settleInput>;
/** The reply's send begun on its channel: the slot and the request file; else why nothing is sent. */
export type Begun =
  | { readonly settled: SendStatus | "gone" }
  | {
      readonly channel: "linkedin";
      readonly accountId: string;
      readonly personId: string;
      readonly reservationId: string;
      readonly requestKey: string;
      readonly retry: boolean;
    };

const files = () => getAdapter(filesPort, filesConfig.PROVIDER_FILES);

/** The reply's request file: `raw/inbox/<messageId>/send.json`. */
export const requestKeyOf = (messageId: string): string =>
  `${REQUEST_FOLDER}/${messageId}/${REQUEST_FILE}`;

/** inbox_reply_begin: the checks again and the slot in a run, then the request file written. */
export async function beginReply(context: Context, input: ReplyInput): Promise<Begun> {
  const { workspaceId } = context;
  const key = requestKeyOf(input.messageId);
  const prepared = await context.tenant(() => prepareReply(input.messageId));
  if ("settled" in prepared) {
    await deleteRequest(workspaceId, key);
    return { settled: prepared.settled };
  }
  const retry = await hasFile(workspaceId, key);
  const body = JSON.stringify(prepared.file);
  await (await files()).put({ workspaceId, key, body, contentType: REQUEST_CONTENT_TYPE });
  const { channel, accountId, personId, reservationId } = prepared;
  return { channel, accountId, personId, reservationId, requestKey: key, retry };
}

/** inbox_reply_settle: the settle's run on the answer, then a settled reply's file deleted. */
export async function settleReplyRun(context: Context, input: SettleInput): Promise<Settled> {
  const settled = await context.tenant(() => settleReply(input, now()));
  if (settled.status !== "unknown") {
    await deleteRequest(context.workspaceId, requestKeyOf(input.messageId));
  }
  return settled;
}

/** Whether the file is there. */
async function hasFile(workspaceId: string, key: string): Promise<boolean> {
  try {
    (await (await files()).get({ workspaceId, key })).body.destroy();
    return true;
  } catch (error) {
    if (isAppError(error) && error.code === filesPort.errors.files_not_found) return false;
    throw error;
  }
}

/** The file deleted; one gone already is no error. */
async function deleteRequest(workspaceId: string, key: string): Promise<void> {
  try {
    await (await files()).delete({ workspaceId, key });
  } catch (error) {
    if (!(isAppError(error) && error.code === filesPort.errors.files_not_found)) throw error;
  }
}
