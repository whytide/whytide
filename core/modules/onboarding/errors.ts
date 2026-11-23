// onboarding's codes (core/packages/platform/README.md "Errors"), each with its key in
// messages/en.json. 400: a website or a proof point's page that is not an http or https URL;
// `details.fields` names each one by its path (`sourceUrl`, `proofPoints.1.sourceUrl`), never the
// value; a Draft of more documents than ONBOARDING_MAX_FILES, `details.files` the setting (README
// "Settings"), the script's and the screen's code for it, which requestDraft checks, since no route
// schema reads the environment. 409: a Draft of a record with neither a website nor a document.
// fetch_failed is no answer of a route: the website fetch keeps it in `fetchError` when the site
// answered no readable page (README "The website fetch"). The drafter's (README "The drafter"): 409,
// an accept or a discard with no pending draft; 500, its task not registered at start; ai_failed,
// draft_failed and draft_empty (README "The automatic accept"), run codes like fetch_failed,
// unregistered.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  company_knowledge_invalid_url: { status: 400 },
  company_knowledge_no_draft: { status: 409 },
  company_knowledge_no_website: { status: 409 },
  documents_too_many: { status: 400 },
  draft_agent_not_loaded: { status: 500 },
  fetch_failed: { status: 502 },
});
