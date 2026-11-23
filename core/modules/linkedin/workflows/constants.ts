// The worker's constants (README.md "Worker"): the profile read's attempts (workflows/index.ts
// linkedin_read_profile) and the post reads' (POST_READ_ATTEMPTS), the daily job's schedule and
// timeout (workflows/daily.ts), the pending invitations' check's patch and timeout (workflows.ts),
// the status refresh's pages and their patch (pages.ts, workflows.ts), the send activities' and the
// check's attempts (send.ts), the health mails' timeout, and the operator's mail's log code. Plain
// values: the workflows' sandbox imports them.

/**
 * The attempts of a profile read at most, the definition's own bound (gamma-p0-080's `attempts`),
 * so that every caller gets it (gamma-p0-085), and the attempt from which a provider error is
 * answered as a refusal, so that the signal run skips that profile instead of failing; the attempts
 * before it fail, and the worker retries them, as it does any other failure until the last. At most
 * the provider kind's 5 (the platform's ACTIVITY_ATTEMPTS).
 */
export const PROFILE_READ_ATTEMPTS = 3;

/**
 * The attempts of a post read at most, the definitions' own bound (gamma-p0-080's `attempts`), so that
 * every caller gets it: linkedin_read_posts (posts.ts) and linkedin_read_post_engagers (index.ts).
 * Not in the sources; at most the provider kind's 5 (the platform's ACTIVITY_ATTEMPTS).
 */
export const POST_READ_ATTEMPTS = 3;

/** The daily job's schedule, linkedin.daily: 00:30 every day in DAILY_ZONE. */
export const DAILY_CRON = "30 0 * * *";

/** The zone of DAILY_CRON, and of the date in each workspace run's id. */
export const DAILY_ZONE = "UTC";

/** A daily activity's start-to-close: a workspace's accounts, a run each, or a purge's batches. */
export const DAILY_TIMEOUT = "10 minutes";

/**
 * The patch of linkedin_status_refresh that runs linkedin_check_invites after each account's refresh
 * (beta-p4-070), asked once at the run's start: a run started before it replays without it.
 */
export const PENDING_INVITES_PATCH = "pending-invites";

/**
 * The workspaces of one linkedin_status_refresh run at most (gamma-p0-085, not in the sources): the
 * run continues as new after each page but the last, with its cursor and its counts (pages.ts).
 */
export const STATUS_REFRESH_PAGE_SIZE = 50;
/**
 * The patch of linkedin_status_refresh that pages the workspaces (gamma-p0-085), asked once at the
 * run's start, as PENDING_INVITES_PATCH is: a run started before it replays unchanged and never
 * continues as new.
 */
export const STATUS_REFRESH_PAGES_PATCH = "status-refresh-pages";

/** linkedin_check_invites' start-to-close: the list's pages and a relation for each invite off it. */
export const INVITES_CHECK_TIMEOUT = "10 minutes";

/**
 * The start-to-close timeout callers give the send activities, and the least hold a send's
 * reservation must have left for the port call (not in the sources), so the call ends within it.
 */
export const SEND_CALL_MARGIN_MS = 2 * 60_000;

/**
 * The least of SEND_CALL_MARGIN_MS an attempt must have left, by its own monotonic clock, to make
 * its port call: one provider request (the Unipile client stops one after 30 s) and the settle. A
 * later attempt makes no call, since Temporal may have started the next one already.
 */
export const SEND_CALL_MIN_LEFT_MS = 45_000;

/**
 * The attempts of linkedin_check_sent at most, the definition's own bound (gamma-p0-085, not in the
 * sources), as each attempt reserves a send_check read: past them the caller's run ends with the
 * step unsettled, and its next run checks first.
 */
export const CHECK_SENT_ATTEMPTS = 3;

/** A send activity's request file: a key under the workspace's raw/, relative to its folder. */
export const RAW_KEY = /^raw\/[\w./-]+\.json$/;
export const RAW_KEY_MAX_CHARS = 512;
/** An account's, a reservation's or a workspace's id at most. */
export const ID_MAX_CHARS = 64;

/** linkedin_mail_health's start-to-close: two short runs, a user read and one mail. */
export const NOTIFY_TIMEOUT = "1 minute";

/** The warn line's code when the fleet breaker trips while LINKEDIN_ALERT_EMAIL is empty. */
export const ALERT_EMAIL_MISSING = "linkedin_alert_email_missing";
