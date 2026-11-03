// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8).
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import { CREDITS_PER_LINKEDIN_SEND } from "./domain/send/constants.ts";

const { default: perSend, min, max } = CREDITS_PER_LINKEDIN_SEND;

export const settings = defineConfig("modules/campaigns", {
  /** The credits of one send, campaigns.linkedin_send's (README.md "Settings"). */
  CAMPAIGNS_CREDITS_PER_LINKEDIN_SEND: z.coerce.number().int().min(min).max(max).default(perSend),
});
