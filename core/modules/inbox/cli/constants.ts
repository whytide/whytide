// The fixed values of `pnpm inbox:export-labels` (README.md "The reply golden set") and of `pnpm
// inbox:report` (README.md "The report"), the two commands of this folder.

/**
 * The exit codes: written; refused (an unknown workspace, a file the files port refused); a usage
 * error, week_invalid included. Through pnpm, any failure is 1.
 */
export const EXIT = { written: 0, refused: 1, usage: 2 } as const;
export const USAGE =
  "usage: pnpm inbox:export-labels [--workspace <id or slug>] [--week <ISO week>]";
export const OPTIONS = { workspace: { type: "string" }, week: { type: "string" } } as const;
/** The service each workspace's tenant runs act as. */
export const SERVICE = "inbox";
/** An id has an underscore and a slug none (tenancy's docs/concepts.md). */
export const ID_MARK = "_";
/** An AppError at or past it is the server's fault, thrown on; under it, a refusal printed. */
export const SERVER_ERROR = 500;

// `pnpm inbox:report` (README.md "The report"; gamma-p7-060).

/** The report's exit codes: printed; refused (an unknown workspace); a usage error. */
export const REPORT_EXIT = { printed: 0, refused: 1, usage: 2 } as const;
export const REPORT_USAGE =
  "usage: pnpm inbox:report [--workspace <id or slug>] [--since <YYYY-MM-DD>]";
export const REPORT_OPTIONS = { workspace: { type: "string" }, since: { type: "string" } } as const;
/** --since: a day, `YYYY-MM-DD`, from its midnight in UTC; without it, every row. */
export const SINCE_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The UTC midnight of a --since day is the day with this time after it. */
export const MIDNIGHT_SUFFIX = "T00:00:00.000Z";
/** The length of an ISO timestamp's date, `YYYY-MM-DD`: a --since day's round trip. */
export const DAY_LENGTH = 10;
/** Without --since, every row: from the epoch. */
export const EVERY_ROW_SINCE_MS = 0;
/**
 * How long a workspace's run may read: each send's step and each person's lead are read one at a
 * time, where Prisma would end a run after 5 seconds (as campaigns' report).
 */
export const REPORT_RUN_TIMEOUT_MS = 120_000;
/** The code each line starts with, in the order the figures are printed. */
export const LINE = Object.freeze({
  replyRateLinkedin: "reply_rate_linkedin",
  positiveWeek: "positive_week",
  positiveConversations: "positive_conversations",
  classifierAgreement: "classifier_agreement",
} as const);
/** What classifier_agreement reads under the pairs it needs. */
export const TOO_FEW = "too_few";
/** A share's decimals, and what one reads when nothing was counted. */
export const SHARE_DECIMALS = 3;
export const NO_SHARE = "none";
