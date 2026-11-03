// The draft's timeouts (README "The draft"): the drafter's attempt, a model call with one retry, and
// the failure mark's, a database write. Plain values: the workflow's sandbox imports them.
export const DRAFT_TIMEOUTS = { draft: "3 minutes", mark: "10 seconds" } as const;
