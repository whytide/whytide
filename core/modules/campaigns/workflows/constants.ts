// campaigns' workflow numbers (README.md "Worker"): the tick, the activities' timeouts and the
// sender's longest sleep. Plain values: the workflows' sandbox imports them.

/** The tick of the plan, and of the queue job of beta-p3-050, in minutes (not in the sources). */
export const TICK_MINUTES = 15;
export const MS_PER_MINUTE = 60_000;

/** A plan activity's start-to-close: a workspace's accounts, one tenant run each, or the tick's starts. */
export const PLAN_TIMEOUT = "1 minute";
/** A queue activity's start-to-close: the tick's starts, a workspace's due steps, or one step. */
export const QUEUE_TIMEOUT = "1 minute";
/** A sender activity's start-to-close: one tenant run, with a request file written or read. */
export const SENDER_TIMEOUT = "1 minute";
/**
 * linkedin's send activities' start-to-close, and its check of a reply's: linkedin's
 * SEND_CALL_MARGIN_MS (its workflows/constants.ts), 2 minutes, which has no export the workflows'
 * sandbox may import, so keep the two equal. An attempt calls only with enough of it left, so an
 * attempt past it never sends beside the next.
 */
export const SEND_ACTIVITY_TIMEOUT = "2 minutes";
/**
 * The longest the sender sleeps before it reads its next step again: the plan's tick, so a step the
 * plan places meanwhile ahead of the one awaited is read within a tick.
 */
export const SENDER_SLEEP_MAX_MS = TICK_MINUTES * MS_PER_MINUTE;

/**
 * The withdrawal job's schedule, campaigns.withdraw (beta-p4-060): daily at 05:00 in WITHDRAW_ZONE
 * (the hour is not in the sources: the plan places each withdrawal inside its account's window).
 */
export const WITHDRAW_CRON = "0 5 * * *";
/** The zone of WITHDRAW_CRON, and of the date in each workspace run's id. */
export const WITHDRAW_ZONE = "UTC";
/** A withdrawal activity's start-to-close: the tick's starts, or a workspace's rows in one run. */
export const WITHDRAW_TIMEOUT = "1 minute";

/**
 * The profile read before a connection request (beta-p4-030): its patch, which beta-p4-020's runs
 * replay without; linkedin's read activity's start-to-close, as signals' readers take it; and the
 * longest key its answer names, the workspace's folder and linkedin's raw key of 512 at most.
 */
export const MEMBER_REFERENCE_PATCH = "member-reference";
export const PROFILE_READ_TIMEOUT = "2 minutes";
export const FILE_KEY_MAX = 1024;

// beta-p4-040, the recovery (README.md "Worker").

/**
 * The patch of beta-p4-040's sender: the checks of its steps left `executing` before the first
 * claim, the gate asked again when its pass is stale, and invites_paused going on to the messages.
 * beta-p4-020's history replays without it.
 */
export const CHECK_EXECUTING = "check-executing";
/**
 * The attempts of a send activity: one. An attempt that fails, linkedin's send_attempt_late
 * included, ends the run `unsettled`, and the next run checks before anything else goes; a retry
 * would call on the first attempt's gate, up to linkedin's hold later.
 */
export const SEND_ATTEMPTS = 1;
/**
 * A send activity's schedule-to-start: a call scheduled on a fresh gate that no worker starts
 * within it fails, so no call goes out on a gate grown stale in the task queue.
 */
export const SEND_START_TIMEOUT = "1 minute";
/**
 * The attempts of linkedin's profile read before a connection request: linkedin's own
 * PROFILE_READ_ATTEMPTS (its workflows/constants.ts), from which a provider error answers a refusal;
 * past them the read has no answer and is settled as not made, each attempt one call at most.
 */
export const PROFILE_READ_ATTEMPTS = 3;
