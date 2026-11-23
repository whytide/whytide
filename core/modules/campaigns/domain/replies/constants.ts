// The reply actions (README.md "Reply actions"; docs/flows.md "A reply's label"), beside their
// readers in this folder: the labels a reply's classification gives (inbox, gamma-p4-040), what each
// one schedules and for how long, what a call answers, and the notices that mail the owner.

/**
 * The labels applyReplyLabel acts on, exported for inbox; the CHECK enrollments_reply_label holds the
 * same list. bounce is email's: until the email phase it records the label alone, as other does.
 */
export const REPLY_ACTION_LABELS = [
  "interested",
  "not_now",
  "not_interested",
  "out_of_office",
  "opt_out",
  "bounce",
  "other",
] as const;
export type ReplyActionLabel = (typeof REPLY_ACTION_LABELS)[number];

// The defaults of four settings (settings.ts, README.md "Settings"), which apply.ts, notice.ts and
// pause-end.ts read as configured. A not-now reply's reminder mails the owner this many days after
// it (CAMPAIGNS_NOT_NOW_REMINDER_DAYS); an out-of-office reply without a return date pauses this
// many days (CAMPAIGNS_OOO_DEFAULT_PAUSE_DAYS); a not-interested reply blocks a new enrollment of
// the person this many days (CAMPAIGNS_NOT_INTERESTED_COOL_DOWN_DAYS).
export const NOT_NOW_REMINDER_DAYS = { default: 30 } as const;
export const OOO_DEFAULT_PAUSE_DAYS = { default: 7 } as const;
export const NOT_INTERESTED_COOL_DOWN_DAYS = { default: 180 } as const;
/** CAMPAIGNS_OOO_RESUME_BUSINESS_DAYS's: a dated pause ends this many business days after it... */
export const OOO_RESUME_BUSINESS_DAYS = { default: 1 } as const;
/** ...at this local time, in the sender account's zone (UTC once linkedin no longer holds it). */
export const OOO_RESUME_TIME = "09:00";
export const OOO_FALLBACK_ZONE = "UTC";
/** A return date as the classification gives it: a calendar date, `YYYY-MM-DD`. */
export const RETURN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What a call did, in order, as inbox keeps it (actions_taken): an out-of-office pause held again
 * and a reminder not yet sent cleared (the undo), the label recorded, the notice published, the
 * reminder set, the held steps cancelled, the cool-down set, the hold released and the enrollment
 * paused, or the person exited as suppressed, or the hold kept (release-hold.ts), and the opt-out.
 */
export const REPLY_ACTIONS = [
  "pause_held_again",
  "reminder_cleared",
  "label_recorded",
  "notice_published",
  "reminder_set",
  "steps_cancelled",
  "cool_down_set",
  "released",
  "paused",
  "exited_suppressed",
  "kept_held",
  "opted_out",
] as const;
export type ReplyAction = (typeof REPLY_ACTIONS)[number];

/** The notices campaigns.reply_notice_due asks for: one mail to the owner each. */
export const REPLY_NOTICE_KINDS = ["interested", "not_now"] as const;
export type ReplyNoticeKind = (typeof REPLY_NOTICE_KINDS)[number];
/** The notice's workflow id: `campaigns.reply_notice:<workspaceId>:<event id>`. */
export const NOTICE_WORKFLOW = "campaigns.reply_notice";
/** The web app's origin, which the links of a notice start with, and its paths (as inbox's). */
export const ORIGIN_VARIABLE = "APP_PUBLIC_ORIGIN";
export const WORKSPACE_PATH = "/w";
export const INBOX_PATH = "inbox";
export const LEADS_PATH = "leads";
/** The longest first name a notice carries; a longer one, which no first name is, reads "a lead". */
export const MAIL_NAME_MAX = 50;
