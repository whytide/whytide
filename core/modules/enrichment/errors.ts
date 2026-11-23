// enrichment's codes (core/packages/platform/README.md "Errors"), each with its key in
// messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** requestEnrichment: no person of the workspace has the id. 404. */
  enrichment_person_not_found: { status: 404 },
  /** requestEnrichment's input is off its rule; `details.fields` names the fields. 400. */
  enrichment_input_invalid: {},
  /**
   * defineSource: a name taken or off its form, or a field or an input it cannot have
   * (`details.field`); a source's answer off its rules, an outcome or a provider, recorded as its
   * step's code. 500.
   */
  enrichment_source_invalid: { status: 500 },
  /** The website source: the site reader's answer failed its schema or its gates twice. 502. */
  enrichment_site_ai_failed: { status: 502 },
  /** The website source: its agent task was not registered at the worker's start. 500. */
  enrichment_site_agent_not_loaded: { status: 500 },
  /** country-ai: the host did not load the country namer's task (loadAgentTasks). 500. */
  enrichment_agent_not_loaded: { status: 500 },
  /** A lookup's candidate file is missing or off its shape (gamma-en-080). 500. */
  enrichment_file_invalid: { status: 500 },
});
