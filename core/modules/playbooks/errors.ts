// playbooks' codes (core/packages/platform/README.md "Errors"), each with its key in
// messages/en.json, playbooks.errors.<code>. `details` holds ids and counts only: `limit` for the
// limit, `sourceIds` for a source refused.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** No agent of the workspace has this id; another workspace's included. */
  playbook_not_found: { status: 404 },
  /**
   * A create past PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE agents not archived (settings.ts);
   * `details.limit`, the value configured.
   */
  playbook_limit_reached: { status: 409 },
  /**
   * setSources with more than PLAYBOOKS_MAX_SOURCES_PER_AGENT distinct ids (settings.ts);
   * `details.limit`, the value configured.
   */
  playbook_sources_limit: { status: 400 },
  /** The audience is none of the workspace's (icp's findAudience answered null). */
  playbook_icp_not_found: { status: 404 },
  /** Another agent not archived has the audience: one live agent per audience. */
  playbook_icp_in_use: { status: 409 },
  /** Another agent holds the sources `details.sourceIds`: a source belongs to one agent. */
  playbook_source_in_use: { status: 409 },
  /** The source checker found none of the workspace's sources by the ids `details.sourceIds`. */
  playbook_source_not_found: { status: 409 },
  /** The sources `details.sourceIds` read through no account of the agent's owner. */
  playbook_source_wrong_owner: { status: 409 },
  /** No source checker is registered (signals', gamma-p5-045): no link is accepted unchecked. */
  playbook_source_checker_missing: { status: 503 },
  /** The agent is archived, which is final: every later change is refused. */
  playbook_archived: { status: 409 },
  /**
   * The agent is paused because its owner left the workspace: only that owner, a member again,
   * resumes it (gamma-p6-075); anyone else, an Owner included, is refused and nothing changes.
   */
  playbook_owner_removed: { status: 409 },
  /** defineSourceChecker: a checker is registered already; one per process, at start. */
  playbook_source_checker_duplicate: { status: 500 },
});
