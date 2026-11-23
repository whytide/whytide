// The constants of the host's alert queue (README "Alerts", alerts.ts): none of them is in the
// sources (gamma-p7-040). The repeat window is a setting, ALERTS_REPEAT_MINUTES (config.ts, README
// "Configuration"), its default here. No import: config.ts reads this file.

/** The most alerts the queue holds; past it the oldest is dropped and counted. */
export const ALERT_QUEUE_MAX = 100;

/** ALERTS_REPEAT_MINUTES's default: an alert whose key was queued within so many minutes is counted. */
export const ALERT_REPEAT = { default: 15 } as const;

/** The attempts one send gets; then the alert is dropped and logged with its code. */
export const ALERT_SEND_ATTEMPTS = 3;

/** The wait before a send's next attempt when the channel gives none, doubling each time. */
export const ALERT_RETRY_BASE_MS = 1_000;

/** The longest wait a channel's `retryAfterSec` gets: the queue waits behind it. */
export const ALERT_RETRY_AFTER_MAX_SEC = 60;

/** How often the timer loop drains the queue. */
export const ALERT_DRAIN_MS = 1_000;

/** The codes a send is never tried again with: the channel refused the text for good. */
export const ALERT_NOT_RETRIED: ReadonlySet<string> = new Set([
  "alerts_rejected",
  "alerts_input_invalid",
]);

/**
 * A name or a code as the text takes it: a word of letters, digits, `_`, `.` and `-`. Anything else
 * (a sentence, an address, a URL, a channel mention) becomes ALERT_UNKNOWN.
 */
export const ALERT_TOKEN = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;
export const ALERT_UNKNOWN = "unknown";

/** An id's shape, `<prefix>_<ULID>`, as platform's ids make it. */
export const ALERT_ID = /^[a-z][a-z0-9]{1,7}_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** An event payload's key whose value may be an id: one ending in `_id` or `Id`. */
export const ALERT_ID_KEY = /^[a-z][A-Za-z0-9_]{0,63}(?:_id|Id)$/;

/** An event payload's key whose number goes into the text. */
export const ALERT_NUMBER_KEY = /^[a-z][A-Za-z0-9_]{0,63}$/;

/** Before a repeat count in the text: `×9`. */
export const ALERT_REPEAT_SIGN = "×";

/** The outbox alert's name: its key is `outbox:dead`. */
export const ALERT_OUTBOX_DEAD = "dead";
