// icp's codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json. Every
// route's is 400: the caller sent a value off the closed lists or weights off 100; `details.fields`
// names the values at fault by their path, never the value, and `details.sum` is the weights' sum.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  icp_weights_must_sum_100: { status: 400 },
  icp_unknown_seniority: { status: 400 },
  icp_unknown_size_range: { status: 400 },
  icp_unknown_country: { status: 400 },
});

/**
 * The draft's codes (README "The draft"), no route's answer, so not the screen's: a brief over its
 * limit, 400; no source to draft from, 409; the drafter's task not registered at the worker's start, 500.
 */
export const draftErrors = defineErrors({
  icp_draft_brief_too_long: { status: 400 },
  icp_draft_no_source: { status: 409 },
  icp_draft_agent_not_loaded: { status: 500 },
});
