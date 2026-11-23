// The credit alerts' values (README "Alerts"; docs/rules/coding.md "constants"), beside their
// readers: settings.ts for the thresholds' default and form, check.ts for the tries,
// workflows/index.ts for the schedule, mail.ts for the recipients, the figures and the link.
import type { Role } from "@whytide/platform";

/**
 * CREDITS_ALERT_THRESHOLDS's default (settings.ts, README "Settings"): the shares of the period's
 * granted credits, in percent, that each raise one alert per period, lowest first.
 */
export const ALERT_THRESHOLDS = { default: [80, 95, 100] } as const;

/**
 * A threshold's bounds, in whole percent: a share of the period's credits, so 100 is its natural top
 * (the CHECK credit_alerts_threshold holds the same).
 */
export const ALERT_THRESHOLD_RANGE = { min: 1, max: 100 } as const;

/** One threshold as CREDITS_ALERT_THRESHOLDS writes it, between its commas: digits only. */
export const ALERT_THRESHOLD_PATTERN = /^[0-9]+$/;

/** How often the schedule credits.alerts checks every organization's share. Not in the sources. */
export const CREDIT_ALERT_CHECK_MINUTES = 15;

/**
 * The checks whose mail of an alert may fail past its attempts, a timeout's included: the check
 * answers the alert again while its tries are under this, so a long mail outage still ends in one
 * mail per recipient. Not in the sources.
 */
export const CREDIT_ALERT_MAX_TRIES = 3;

/**
 * The advisory lock of one alert's send to one user (mail.ts), `<this>:<alertId>:<userId>`, so that
 * two mails of the alert at once send each recipient once.
 */
export const ALERT_MAIL_LOCK = "credits.alert_mail";

/**
 * How long one recipient's send may hold its lock and its transaction, in milliseconds: past the
 * SMTP adapter's 50 seconds at most. A send that outlasts it fails its record, and the next attempt
 * mails that recipient again.
 */
export const ALERT_SEND_HOLD_MS = 120_000;

/** The roles mailed: Owner, and Admin, declared beside it for credit alerts (F18 §4). */
export const CREDIT_ALERT_ROLES: readonly Role[] = ["Owner", "Admin"];

/** The mail's amounts in the reader's locale, to four decimals at most, as the credits screens show them. */
export const MAIL_AMOUNT_FORMAT: Intl.NumberFormatOptions = Object.freeze({
  maximumFractionDigits: 4,
});

/** The period's end in the mail: a day in UTC, the zone of the periods, as the costs page shows it. */
export const MAIL_DATE_FORMAT: Intl.DateTimeFormatOptions = Object.freeze({
  dateStyle: "long",
  timeZone: "UTC",
});

/** The web app's origin: the api's variable, which the worker reads too. Empty: no link. */
export const ORIGIN_VARIABLE = "APP_PUBLIC_ORIGIN";
/** A workspace's pages in the web app sit under `/w/<workspaceId>`. */
export const WORKSPACE_PATH = "/w";
/** The costs page under its workspace's (ui/nav.ts `pages`). */
export const CREDITS_PATH = "credits";
