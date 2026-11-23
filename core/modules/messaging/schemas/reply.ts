// The reply writer's data, version 1 (agents/write-reply/README.md; inbox-reply-draft): one field per
// data block of its prompt. The dossier's blocks are the message writer's (writer.ts), built by
// domain/drafts/blocks.ts; the conversation, oldest first, and the member's brief are untrusted data,
// never instructions; <failures> holds the issues of the one earlier answer; <request> is the
// caller's id of the request, so that each new request is a new call (version 2). The answer is a
// text.
import { z } from "zod";
import { TEXT_LANGUAGES } from "../domain/gates/constants.ts";
import {
  REPLY_AUTHORS,
  REPLY_BRIEF_MAX,
  REPLY_CHAT_MAX,
  REPLY_MESSAGE_CHARACTERS_MAX,
  REPLY_REWRITES,
} from "../domain/replies/constants.ts";
import { blocks, gateIssue } from "./writer.ts";

/** The task's name in the agent registry. */
export const WRITE_REPLY = "messaging.write-reply";

const message = z.object({
  from: z.enum(REPLY_AUTHORS),
  at: z.iso.datetime(),
  text: z.string().min(1).max(REPLY_MESSAGE_CHARACTERS_MAX),
});
export type ReplyChatMessage = z.output<typeof message>;

export const writeReplyInput = z.object({
  /** A LinkedIn message's most characters, and the language code read from the lead's messages. */
  channel: z.object({
    channel: z.literal("linkedin_message"),
    maxCharacters: z.int(),
    language: z.enum(TEXT_LANGUAGES),
  }),
  dossier: blocks.dossier,
  lead: blocks.lead,
  why_now: blocks.why_now,
  /** Untrusted: the thread's latest messages, oldest first. */
  conversation: z.array(message).min(1).max(REPLY_CHAT_MAX),
  /** Untrusted: what the member wants the reply to say or do; null for none. */
  brief: z.string().min(1).max(REPLY_BRIEF_MAX).nullable(),
  failures: z.array(z.array(gateIssue)).max(REPLY_REWRITES),
  /** The ready draft this one replaces, which the member asked again: a different one. */
  replaced: z.string().nullable(),
  /**
   * The caller's id of this request, inbox's draft id: callAgent's cache keys on the input's hash, so
   * a new request, Try again after a failure among them, asks the model again, while an activity's
   * retry of the same request finds the calls it already paid for. It says nothing about the reply.
   */
  request: z.string().min(1).max(64),
});
export type WriteReplyInput = z.output<typeof writeReplyInput>;
export const writeReplyOutput = z.object({ text: z.string().min(1).max(4_000) });
