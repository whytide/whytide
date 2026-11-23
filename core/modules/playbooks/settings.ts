// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8): the
// agents' limits (README "Settings"), read once as the module loads, so that a value that is not an
// integer of 1 or more stops the start with config_invalid. The commands and the list's answer read
// them; the screens never import this file: they show the limits the list answers.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import { AGENTS_PER_WORKSPACE, SOURCES_PER_AGENT } from "./domain/constants.ts";

export const settings = defineConfig("modules/playbooks", {
  /** The agents not archived in one workspace, 1 or more, no maximum (README "Settings"). */
  PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE: z.coerce
    .number()
    .int()
    .positive()
    .default(AGENTS_PER_WORKSPACE.default),
  /** The sources one agent holds, 1 or more, no maximum (README "Settings"). */
  PLAYBOOKS_MAX_SOURCES_PER_AGENT: z.coerce
    .number()
    .int()
    .positive()
    .default(SOURCES_PER_AGENT.default),
});
