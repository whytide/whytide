// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8): the
// reply classifier's model, named by the ai package's convention AI_MODEL_<MODULE>_<AGENT>; unset,
// the LLM port's first model (gamma-p4-040), and the confidence under which its label is only
// suggested (env-settings-a; README.md "Settings"), read once as the module loads, so that a value
// off its range stops the start with config_invalid. The opt-out phrases are constants
// (domain/opt-out/constants.ts), never a setting. The agent's task file reads it, so it imports no
// registry of the module, only the plain default of domain/classify/constants.ts.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import { SUGGEST_BELOW } from "./domain/classify/constants.ts";

export const settings = defineConfig("modules/inbox", {
  /** The reply classifier's (agents/classify-reply/README.md). */
  AI_MODEL_INBOX_CLASSIFY_REPLY: z.string().min(1).optional(),
  /** A model's label under this confidence is suggested: above 0 and at most 1 (README.md). */
  INBOX_CLASSIFY_SUGGEST_BELOW: z.coerce.number().gt(0).max(1).default(SUGGEST_BELOW.default),
});
