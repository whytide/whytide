// The mailboxes routes' bodies and answers (README.md "API"). An answer never holds a token.
import { MAILBOX_PROVIDERS } from "@whytide/providers";
import { z } from "zod";

export const connectBody = z.strictObject({
  provider: z.enum(MAILBOX_PROVIDERS),
  /** An IANA zone, the browser's. */
  timeZone: z.string().min(1).max(64),
});
export type ConnectBody = z.infer<typeof connectBody>;
export const connectResponse = z.strictObject({ url: z.string() });

export const callbackBody = z.strictObject({
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(4096),
});
export type CallbackBody = z.infer<typeof callbackBody>;

export const mailboxParams = z.strictObject({ mailboxId: z.string().min(1).max(64) });

export const mailboxResponse = z.strictObject({
  id: z.string(),
  ownerUserId: z.string(),
  /** The caller owns it: only they disconnect or reconnect it. */
  mine: z.boolean(),
  provider: z.enum(MAILBOX_PROVIDERS),
  emailAddress: z.string(),
  displayName: z.string(),
  status: z.enum(["connected", "disconnected"]),
  disconnectedReason: z.enum(["user", "token_revoked", "member_removed"]).nullable(),
  isFreeConsumer: z.boolean(),
  timeZone: z.string(),
  connectedAt: z.iso.datetime(),
  disconnectedAt: z.iso.datetime().nullable(),
});
export type MailboxResponse = z.infer<typeof mailboxResponse>;
export const mailboxListResponse = z.strictObject({ mailboxes: z.array(mailboxResponse) });
