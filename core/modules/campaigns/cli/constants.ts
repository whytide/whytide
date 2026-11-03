// The fixed values of `pnpm campaigns:report` (README.md "Commands"; docs/runbook.md "The report"):
// its exit codes, usage and options, the code each line starts with, the windows of its figures and
// the targets of beta's "Done when" (roadmaps/02-beta.md).

/**
 * The exit codes: the report ran and the three zeros hold; a zero is broken, or the command was
 * refused (workspace_not_found); a usage error. Through pnpm, any failure is 1.
 */
export const EXIT = { clean: 0, violations: 1, usage: 2 } as const;
export const USAGE =
  "usage: pnpm campaigns:report [--workspace <id or slug>] [--since <YYYY-MM-DD>]";
export const OPTIONS = { workspace: { type: "string" }, since: { type: "string" } } as const;

/** The code each line starts with, in the order the figures are printed. */
export const LINE = Object.freeze({
  sendsWithoutApproval: "sends_without_approval",
  sendStepMissing: "send_step_missing",
  missingStep: "missing_step",
  actionsAgainstSuppressed: "actions_against_suppressed",
  duplicateSends: "duplicate_sends",
  violation: "violation",
  draftsSmallEdits: "drafts_small_edits",
  acceptanceRate: "acceptance_rate",
  acceptanceRateSender: "acceptance_rate_sender",
  sendersThreeWeeks: "senders_three_weeks",
  senderSpan: "sender_span",
  restrictions: "restrictions",
  checkpoints: "checkpoints",
  healthEvent: "health_event",
  decisionDays: "decision_days",
} as const);

/**
 * The acceptance rate counts a connection request sent at least this many days before the run:
 * linkedin's acceptance rule's week, so fresh invites do not pull the rate down.
 */
export const REPORT_ACCEPTANCE_MIN_AGE_DAYS = 7;
/** A sender counts in senders_three_weeks when its sends span this many days or more. */
export const SENDER_SPAN_DAYS = 21;
/** decision_days covers the local days before the run's day: the last week. */
export const DECISION_WINDOW_DAYS = 7;
/** beta's "Done when": the share approved with no or small edits, the acceptance rate, the senders. */
export const TARGETS = Object.freeze({ smallEdits: 0.5, acceptance: 0.25, senders: 3 });

/** The service each workspace's tenant run acts as. */
export const SERVICE = "campaigns";
/** An id has an underscore and a slug none (tenancy's docs/concepts.md). */
export const ID_MARK = "_";
/** --since: a day, `YYYY-MM-DD`, from its midnight in UTC; without it, every row. */
export const SINCE_DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * How long a workspace's run may read: the zeros look up each send one at a time, a few thousand at
 * beta's volume, where Prisma would end a run after 5 seconds.
 */
export const REPORT_RUN_TIMEOUT_MS = 120_000;
/** A share's decimals, and what one reads when nothing was counted. */
export const SHARE_DECIMALS = 3;
export const NO_SHARE = "none";
/** What a log row naming no step execution shows in place of its id. */
export const NO_STEP = "none";
