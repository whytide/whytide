// The country namer (README.md beside this file, gamma-en-075): a lead's location text, which the
// place list could not read, to a country's code and whether the model is sure. A host's
// loadAgentTasks() imports this file from the sources while the worker runs the module from dist/,
// so it imports no registry of the module (index.ts, events.ts, ids.ts, errors.ts) and the module
// never imports it: country-ai takes the task from the agent registry.
import { defineAgentTask } from "@whytide/ai";
import { countryCodeGate } from "../../domain/name-country-gate.ts";
import { NAME_COUNTRY, nameCountryInput, nameCountryOutput } from "../../schemas/name-country.ts";
import { settings } from "../../settings.ts";

export const nameCountryTask = defineAgentTask(
  {
    name: NAME_COUNTRY,
    module: "enrichment",
    kind: "classification",
    model: settings.AI_MODEL_ENRICHMENT_NAME_COUNTRY,
    promptVersion: 1,
    inputSchema: nameCountryInput,
    outputSchema: nameCountryOutput,
    // The country costs no credit (the enrichment README's decisions): the cost event alone.
    budget: { maxInputTokens: 2_000, maxOutputTokens: 100, maxCostCredits: 0 },
    tools: [],
    gates: [countryCodeGate],
  },
  import.meta.url,
);
