// What the worker's onboarding tests share: the drafter's task loaded from the sources as a host loads
// it, the LLM fake, and onboarding as the worker loads it, its drafter calling the model as the test's
// app role (callAgent's own client is the public schema). Imported once the environment is set.
import { loadAgentTasks } from "@whytide/ai";
import { asRole } from "@whytide/db/testing";
import type { ActivityContext, ActivityDefinition } from "@whytide/platform";
import { getAdapter, type LlmFake, llmPort } from "@whytide/providers";
import { moduleLoaders } from "../../src/modules.generated.ts";
import type { ModuleLoader } from "../../src/modules.ts";

const TASK = "../../../../modules/onboarding/agents/draft-company-knowledge/task.ts";
await loadAgentTasks([new URL(TASK, import.meta.url).href]);
export const fake = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
const prices = {
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
};

/** A draft with no value: every gate passes it, and accepting it changes nothing. */
export const NOTHING_DRAFTED = {
  ...{ oneLiner: null, longDescription: null, tone: null },
  ...{ products: [], painPoints: [], featuresBenefits: [], proofPoints: [], competitors: [] },
};

/** The drafter's activity with callAgent's options: the test's schema and the fake's price. */
function withCall(definition: ActivityDefinition): ActivityDefinition {
  if (definition.scope === "global") return definition;
  const { run } = definition;
  return {
    ...definition,
    run: (input, context: ActivityContext) => {
      // What draftFromPages reads besides the context (domain/drafter.ts, DraftContext).
      const withCall = { ...context, call: { client: asRole("app"), prices } };
      return run(input, withCall);
    },
  };
}

/** onboarding as the worker's loader loads it from its build, its drafter calling as above. */
export const onboarding: ModuleLoader[] = moduleLoaders
  .filter(({ name }) => name === "onboarding")
  .map((loader) => ({
    ...loader,
    workflows: async () => {
      const declared = (await loader.workflows?.()) as {
        readonly activities: Record<string, ActivityDefinition>;
      };
      const activities = Object.fromEntries(
        Object.entries(declared.activities).map(([name, definition]) => [
          name,
          name === "onboarding_draft_from_pages" ? withCall(definition) : definition,
        ]),
      );
      return { ...declared, activities };
    },
  }));
