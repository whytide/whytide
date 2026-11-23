// icp's codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json. The
// ICP's and its criteria's routes answer 400: the caller sent a value off the closed lists or weights
// off 100; `details.fields` names the values at fault by their path, never the value, and
// `details.sum` is the weights' sum. An audience's id the workspace does not hold is 404; a create
// past ICP_MAX_AUDIENCES_PER_WORKSPACE (settings.ts) 409, `details.limit` the value configured.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  icp_weights_must_sum_100: { status: 400 },
  icp_unknown_seniority: { status: 400 },
  icp_unknown_size_range: { status: 400 },
  icp_unknown_country: { status: 400 },
  icp_not_found: { status: 404 },
  icp_audience_limit: { status: 409 },
});

/**
 * The draft's codes (README "The draft"), its routes' and the script's: a brief over its limit, 400;
 * no source to draft from, 409; no drafted proposal to use or discard, 409; a proposal used over an
 * ICP with targeting without `replace`, 409; a proposal off the PUT body's schema, 422,
 * `details.fields` naming its paths, never a value; the drafter's task not registered at the worker's
 * start, 500, which no route answers.
 */
export const draftErrors = defineErrors({
  icp_draft_brief_too_long: { status: 400 },
  icp_draft_no_source: { status: 409 },
  icp_draft_none: { status: 409 },
  icp_not_empty: { status: 409 },
  icp_draft_invalid: { status: 422 },
  icp_draft_agent_not_loaded: { status: 500 },
});
