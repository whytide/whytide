// The reply route's shapes (README.md "API", "Replies from the inbox"; core/apps/api/README.md
// "OpenAPI and the client"): the member's text, trimmed, and the answer, the reply's message, sending.
// The text is personal data: the row's body, then the request file, never an event, a workflow's
// input or a log line.
import { z } from "zod";
import { REPLY_TEXT_MAX } from "../domain/reply/constants.ts";
import { ID_MAX } from "../domain/store/constants.ts";

/** The reply's text: REPLY_TEXT_MAX at most here, the channel's own longest at the route's run. */
export const replyBody = z.strictObject({ text: z.string().trim().min(1).max(REPLY_TEXT_MAX) });
export type ReplyBody = z.output<typeof replyBody>;
/** The reply's message, its send under way: the thread shows it `sending` until it settles. */
export const replyResponse = z.strictObject({
  messageId: z.string().min(1).max(ID_MAX),
  status: z.literal("sending"),
});
export type ReplyResponse = z.output<typeof replyResponse>;
