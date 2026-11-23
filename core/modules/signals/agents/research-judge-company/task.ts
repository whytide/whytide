// The company judge (README.md beside this file; gamma-wr-050): for one company a research run found,
// whether its own site shows what the member looks for, answered in closed questions with a quote of
// the site for each answer. A host's loadAgentTasks() imports this file from the sources while the
// worker runs the module from dist/, so it imports no registry of the module (index.ts, events.ts,
// ids.ts, errors.ts) and the module never imports it: judgeCompany takes the task from the agent
// registry. Its gates, which refuse a part of the answer and keep the rest, run after the call
// (domain/research/judge-checks.ts), not here: a task gate refuses the whole answer. The verdict is
// code's (domain/research/verdict.ts).
import { defineAgentTask } from "@whytide/ai";
import { signalsConfig } from "../../config.ts";
import {
  RESEARCH_JUDGE_COMPANY,
  researchJudgeInput,
  researchJudgeOutput,
} from "../../schemas/research-judge-company.ts";

export const researchJudgeCompanyTask = defineAgentTask(
  {
    name: RESEARCH_JUDGE_COMPANY,
    module: "signals",
    kind: "classification",
    model: signalsConfig.AI_MODEL_SIGNALS_RESEARCH_JUDGE_COMPANY,
    promptVersion: 1,
    inputSchema: researchJudgeInput,
    outputSchema: researchJudgeOutput,
    // 50,000 characters of the site and the audience's lists come to 60,000 tokens at most in a script
    // of three-byte characters; the answer is a few dozen short lines and quotes.
    budget: { maxInputTokens: 64_000, maxOutputTokens: 6_000, maxCostCredits: 0 },
    tools: [],
  },
  import.meta.url,
);
