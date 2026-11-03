// The package's error codes (docs/rules/coding.md §9). A developer reads them, never a person, so
// they have no message keys; `details` names the task and what was refused, never a prompt or an input.
import { defineErrors } from "@whytide/platform";

export const aiErrors = defineErrors({
  /** A task definition the registry refuses: `details.field` and `details.reason` say why. */
  ai_task_invalid: {},
  /** Two task files declare one name: `details.sources` names both. */
  ai_task_duplicate: {},
  /** The prompt file is missing, lacks the data-block header, or names other blocks than the input. */
  ai_prompt_invalid: {},
  /** runAgent's input does not match the task's input schema: `details.fields`. */
  ai_input_invalid: {},
  /** The estimated input tokens exceed the task's `maxInputTokens`; no model was called. */
  ai_budget_exceeded: {},
  /** `MASTRA_LICENSE_KEY` or `MASTRA_EE_LICENSE` is set: the process refuses to start. */
  ai_mastra_license_set: {},
  /** A model named by a string id reached the AI SDK's default provider; only the port's models run. */
  ai_model_id_refused: {},
  /** Mastra failed without a port code: `details.reason` is its error id. */
  ai_agent_failed: {},
  /** The grounding sample's week or record is not valid: `details.fields`. */
  ai_grounding_input_invalid: {},
  /** Two modules define a grounding source of one kind: `details.kind`. */
  ai_grounding_source_duplicate: {},
  /** No loaded module defines a grounding source of the kind: `details.kind`. */
  ai_grounding_source_missing: {},
});
