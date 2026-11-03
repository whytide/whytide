// qualification's codes (core/packages/platform/README.md "Errors"), each with its key in
// messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** assessPerson's or erasePerson's input is off its rule; `details.fields` names the fields. 400. */
  qualification_input_invalid: {},
  /** assessPerson: the ICP is at another version than the caller's; nothing was assessed. 409. */
  icp_version_stale: { status: 409 },
  /** assessPerson ran in a process that did not load the agent tasks (loadAgentTasks). 500. */
  assessment_agent_not_loaded: { status: 500 },
  /** scoreSnapshot: no snapshot of the workspace has this id. 404. */
  score_snapshot_not_found: { status: 404 },
});
