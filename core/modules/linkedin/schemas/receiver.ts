// The file of a message the receiver kept (README.md "The webhook"; domain/receiver/): the event's
// refs, its side and time and its text, under the account's workspace at
// raw/linkedin/messages/<event_key_hash>.json, which the files port keeps 72 hours. The event
// linkedin.message_received names the file and carries no text; its subscriber reads the file through
// this schema and deletes it. Never the account's own reference.
import { z } from "zod";

/** The message file: refs at the vendor, `sentAt` in ISO, the text as the provider gave it. */
export const messageFile = z.strictObject({
  chatRef: z.string().min(1),
  messageRef: z.string().min(1),
  senderMemberRef: z.string().min(1),
  attendeeMemberRefs: z.array(z.string().min(1)),
  /** Sent by the account itself, from Whytide or by hand; false for the person's message. */
  fromAccount: z.boolean(),
  sentAt: z.iso.datetime(),
  /** Personal data: in this file only, never in an event, a log line or a metric label. */
  text: z.string(),
});
export type MessageFile = z.output<typeof messageFile>;
