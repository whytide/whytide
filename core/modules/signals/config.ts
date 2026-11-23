// The noise rules' term lists (README.md "Processing"), English only, which decide a batch the
// triage could not answer (signals-triage-ai), and the models of the rating, triage and research plan
// agents (gamma-wr-040) the research result-picking agent (gamma-wr-045) and the research page-reading agent (gamma-wr-046), the research company judge (gamma-wr-050), the research people agents (gamma-wr-060), the `modules/signals` block of deploy/.env.example (README.md "Settings"),
// named by the ai package's convention AI_MODEL_<MODULE>_<AGENT>; unset, the LLM port's first model.
// The agents' task files read them, so this file imports nothing of the module.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

/** A headline or a title holding one of these, as whole words in any case, is a recruiter's. */
export const NOISE_RECRUITER_TERMS = [
  "recruiter",
  "talent acquisition",
  "headhunter",
  "sourcer",
  "staffing",
] as const;

/** A headline holding one of these, as whole words in any case, is a job seeker's. */
export const NOISE_JOB_SEEKER_PHRASES = [
  "open to work",
  "#opentowork",
  "looking for opportunities",
  "seeking new opportunities",
  "looking for a new role",
] as const;

export const signalsConfig = defineConfig("modules/signals", {
  AI_MODEL_SIGNALS_RATE_ENGAGEMENT: z.string().min(1).optional(),
  AI_MODEL_SIGNALS_RESEARCH_JUDGE_COMPANY: z.string().min(1).optional(),
  AI_MODEL_SIGNALS_RESEARCH_PICK_PEOPLE: z.string().min(1).optional(),
  AI_MODEL_SIGNALS_RESEARCH_PICK_RESULTS: z.string().min(1).optional(),
  AI_MODEL_SIGNALS_RESEARCH_PLAN: z.string().min(1).optional(),
  AI_MODEL_SIGNALS_RESEARCH_READ_PAGE: z.string().min(1).optional(),
  AI_MODEL_SIGNALS_RESEARCH_READ_PEOPLE: z.string().min(1).optional(),
  AI_MODEL_SIGNALS_RESEARCH_READ_RESULT: z.string().min(1).optional(),
  AI_MODEL_SIGNALS_TRIAGE_ENGAGERS: z.string().min(1).optional(),
});
