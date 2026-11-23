// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8): a
// LinkedIn note's limit, and the four agents' models, named by the ai package's convention
// AI_MODEL_<MODULE>_<AGENT>; unset, the LLM port's first model. The agents' task files read it, so
// it imports nothing of the module.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

export const settings = defineConfig("modules/messaging", {
  /** A connection request's note, at most this many characters (LinkedIn's limit: 200, or 300). */
  LINKEDIN_NOTE_LIMIT: z.coerce.number().int().min(1).max(300).default(200),
  AI_MODEL_MESSAGING_PLAN_MESSAGE: z.string().min(1).optional(),
  AI_MODEL_MESSAGING_WRITE_MESSAGE: z.string().min(1).optional(),
  /** The email writer's (agents/write-email/README.md; gamma-p3-070). */
  AI_MODEL_MESSAGING_WRITE_EMAIL: z.string().min(1).optional(),
  /** The inbox's reply writer's (agents/write-reply/README.md; inbox-reply-draft). */
  AI_MODEL_MESSAGING_WRITE_REPLY: z.string().min(1).optional(),
});
