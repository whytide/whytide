// The site reader (README.md beside this file): a company's own pages become its industry, size,
// headquarters' country and description, each value with its page and a quote of it. A host's
// loadAgentTasks() imports this file from the sources while the worker runs the module from dist/,
// so it imports no registry of the module (index.ts, events.ts, ids.ts, errors.ts) and the module
// never imports it: the website source takes the task from the agent registry.
import { defineAgentTask } from "@whytide/ai";
import { READ_SITE_GATES } from "../../domain/sources/website/gates.ts";
import {
  READ_COMPANY_SITE,
  readCompanySiteInput,
  readCompanySiteOutput,
} from "../../schemas/read-company-site.ts";
import { settings } from "../../settings.ts";

export const readCompanySiteTask = defineAgentTask(
  {
    name: READ_COMPANY_SITE,
    module: "enrichment",
    kind: "classification",
    model: settings.AI_MODEL_ENRICHMENT_READ_COMPANY_SITE,
    promptVersion: 1,
    inputSchema: readCompanySiteInput,
    outputSchema: readCompanySiteOutput,
    // 60,000 characters of pages, at most 81,000 bytes, about 20,000 input tokens a company (the
    // README's "Input"). Company data costs no credits (the owner, 2026-11-13): the cost event alone
    // records the call.
    budget: { maxInputTokens: 30_000, maxOutputTokens: 4_000, maxCostCredits: 0 },
    tools: [],
    gates: READ_SITE_GATES,
  },
  import.meta.url,
);
