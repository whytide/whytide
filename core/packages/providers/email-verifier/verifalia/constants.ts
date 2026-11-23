// The verifalia adapter's calls and bounds (README.md "Covers"), read on 2026-11-13 in Verifalia's
// developer documentation: core concepts (its hosts, statuses and rate limits), authentication,
// "Creating jobs" and "Retrieving jobs" (its entries' classifications and statuses).
import type { Allowance } from "../../_pattern/index.ts";
import type { EmailVerdict } from "../port.ts";

/** The API's round-robin host and its jobs, on version 2.7. */
export const VERIFALIA_ORIGIN = "https://api.verifalia.com";
export const JOBS_PATH = "/v2.7/email-validations";
/** How long the vendor may hold a request for the job to finish, in milliseconds: `waitTime`. */
export const WAIT_TIME = "waitTime";
export const WAIT_TIME_MAX_MS = 30_000;
/** A job's id, as the answer's `overview.id` gives it: a UUID. */
export const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The status of an answer whose job is still running, and a finished job's `overview.status`. */
export const IN_PROGRESS_STATUS = 202;
export const COMPLETED = "Completed";

/** The user's variables, which `requires` names, and the free plan's allowance, the default. */
export const USERNAME_VARIABLE = "VERIFALIA_USERNAME";
export const PASSWORD_VARIABLE = "VERIFALIA_PASSWORD";
export const DEFAULT_ALLOWANCE: Allowance = Object.freeze({ calls: 25, per: "day" });

/**
 * The whole check's budget, the job created and read until done: 10 seconds (the task). Each request
 * asks the vendor to wait at most the budget left less WAIT_MARGIN_MS, so that its answer, done or
 * not, arrives before the budget ends; a job still running then is the provider error. At most
 * POLLS_MAX reads follow the creation, in case the vendor answers sooner than asked.
 */
export const BUDGET_MS = 10_000;
export const WAIT_MARGIN_MS = 1_000;
export const POLLS_MAX = 5;
/** The longest answer read: one entry's job is under 4 KiB. */
export const MAX_ANSWER_BYTES = 64 * 1024;
/** The seconds a rate limit asks to wait when its Retry-After gives none. */
export const RETRY_AFTER_SEC = 1;

/** An entry's statuses that decide the verdict whatever its classification (README.md "Mapping"). */
export const STATUS_VERDICTS: Readonly<Record<string, EmailVerdict>> = {
  ServerIsCatchAll: "catch_all",
  MailboxHasInsufficientStorage: "risky",
  MailboxIsDea: "risky",
  DomainIsWellKnownDea: "risky",
  MailExchangerIsWellKnownDea: "risky",
  MailExchangerIsHoneypot: "risky",
};
/** An entry's classification as a verdict; any other, a custom one included, is unknown. */
export const CLASSIFICATION_VERDICTS: Readonly<Record<string, EmailVerdict>> = {
  Deliverable: "valid",
  Risky: "risky",
  Undeliverable: "invalid",
  Unknown: "unknown",
};
