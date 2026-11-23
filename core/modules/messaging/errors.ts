// messaging's codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** buildDossier, GET …/leads/{personId}/dossier: the workspace has no lead for the person. 404. */
  dossier_lead_not_found: {},
  /** A command's input is off its rule; `details.fields` names the fields, no value. 400. */
  messaging_input_invalid: {},
  /** The draft routes, writeDraft, approveStepDraft: the workspace has no draft of the id. 404. */
  draft_not_found: {},
  /**
   * PATCH and regenerate of a draft its writer has not finished: it is `drafting`; approveStepDraft
   * of a draft approved already, whose text is frozen. 409.
   */
  draft_not_editable: { status: 409 },
  /** PATCH and regenerate of a sequence step's draft: only approvals' path changes one. 409. */
  step_draft_not_editable: { status: 409 },
  /** writeDraft: a host started without the writer's agent tasks loaded (loadAgentTasks). 500. */
  writer_agent_not_loaded: {},
  /**
   * PATCH of a lead's draft, approveStepDraft: the text fails a gate of checkText; `details.issues`
   * holds the gates' issues, which may quote the text's words, the member's own. 400.
   */
  draft_text_refused: { status: 400 },
  /**
   * approveStepDraft of a draft its writer has not finished: it is `drafting`. approveStepDraftByMode
   * of any draft but a `ready` LinkedIn message or email with a text (gamma-p4-080). 409.
   */
  draft_not_ready: { status: 409 },
  /** approveStepDraft of a lead's draft, or of another step execution's. 409. */
  draft_step_mismatch: { status: 409 },
  /**
   * PATCH of a lead's draft, approveStepDraft: a subject for a draft that has none, a follow-up
   * email (its thread's) or a LinkedIn text; only a first email has one (gamma-p3-070). 400.
   */
  draft_subject_not_allowed: { status: 400 },
  /**
   * approveStepDraftByMode: the draft's text, alone or with its AI disclosure line, fails a gate of
   * checkText, the length most often (gamma-p4-080); `details.gates` names the gates, never the
   * text's words. The draft stays `ready`, for a person. 409.
   */
  disclosure_check_failed: { status: 409 },
});
