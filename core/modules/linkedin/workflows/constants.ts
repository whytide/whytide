// The worker's constants (README.md "Worker"): the profile read's attempts (workflows/index.ts
// linkedin_read_profile), the daily job's schedule and timeout (workflows/daily.ts), the pending
// invitations' check's patch and timeout (workflows.ts), the send activities' (send.ts), the health
// mails' timeout, and the operator's mail's log code. Plain values: the workflows' sandbox imports
// them.

/**
 * The attempt from which a provider error on a profile read is answered as a refusal, so that the
 * signal run skips that profile instead of failing; the attempts before it fail, and the worker
 * retries them. It must stay at most the worker's attempts of a provider activity (5,
 * ACTIVITY_ATTEMPTS in core/apps/worker/src/retry.ts): past those the activity fails, refusal or not.
 */
export const PROFILE_READ_ATTEMPTS = 3;

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

/** A send activity's request file: a key under the workspace's raw/, relative to its folder. */
export const RAW_KEY = /^raw\/[\w./-]+\.json$/;
export const RAW_KEY_MAX_CHARS = 512;
/** An account's or a reservation's id at most. */
export const ID_MAX_CHARS = 64;

/** linkedin_mail_health's start-to-close: two short runs, a user read and one mail. */
export const NOTIFY_TIMEOUT = "1 minute";

/** The warn line's code when the fleet breaker trips while LINKEDIN_ALERT_EMAIL is empty. */
export const ALERT_EMAIL_MISSING = "linkedin_alert_email_missing";
