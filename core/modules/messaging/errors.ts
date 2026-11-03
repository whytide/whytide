// messaging's codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** buildDossier, GET …/leads/{personId}/dossier: the workspace has no lead for the person. 404. */
  dossier_lead_not_found: {},
  /** A command's input is off its rule; `details.fields` names the fields, no value. 400. */
  messaging_input_invalid: {},
  /** The draft routes, writeDraft: the workspace has no draft of the id. 404. */
  draft_not_found: {},
  /** PATCH and regenerate of a draft its writer has not finished: it is `drafting`. 409. */
  draft_not_editable: { status: 409 },
  /** writeDraft: a host started without the writer's agent tasks loaded (loadAgentTasks). 500. */
  writer_agent_not_loaded: {},
});
