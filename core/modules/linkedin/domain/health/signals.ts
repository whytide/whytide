// Where a port error meets the account's health (README.md "Health"; A.19's account column): in the
// run that logs the error of a send, a check or a read, after its row. A warning, LinkedIn's limit or
// a lost session, is a signal for applyHealth; a rate limit or a provider error counts towards the
// third in the window, which pauses the account's sends and reads until its next working day
// through retry_at, with a health event and the owner's mail, and leaves the health state, the
// cool-down and the fleet breaker as they are (the owner's decision of 2026-10-29). The third counts
// distinct calls, not attempts (the coordinator's decision for the owner, 2026-10-30): the rows of
// one call share its `call_ref`, so one profile the provider cannot read, tried three times, is one.
import { tenantClient } from "@whytide/db";
import {
  addBusinessDays,
  instantAt,
  isAppError,
  MONDAY_TO_FRIDAY,
  quotaDay,
} from "@whytide/platform";
import { linkedinPort } from "@whytide/providers";
import { outcomeOf } from "../action-log/log.ts";
import { QUOTA_DAY_START } from "../quota/constants.ts";
import { applyHealth, lockAccount, recordHealthEvent } from "./apply.ts";
import {
  PROVIDER_ERROR_WINDOW_MINUTES,
  PROVIDER_ERROR_WINDOW_MS,
  PROVIDER_ERRORS_PER_HOUR_MAX,
} from "./constants.ts";
import type { HealthSignal, HealthTrigger } from "./states.ts";

/** A port error's signal and its trigger. */
export type ErrorSignal = {
  readonly signal: Extract<HealthSignal, "restricted" | "checkpoint" | "disconnected">;
  readonly trigger: HealthTrigger;
};

const { linkedin_account_disconnected, linkedin_limit_reached } = linkedinPort.errors;
/** The codes the third error counts, as the action log records them. */
const PROVIDER_ERROR_CODES: readonly string[] = Object.freeze([
  linkedinPort.errors.linkedin_rate_limited,
  linkedinPort.errors.linkedin_provider_error,
]);

/**
 * A typed error's health signal, A.19's account column: linkedin_limit_reached restricted
 * (limit_reached); linkedin_account_disconnected by `details.reason`, checkpoint checkpoint,
 * restricted restricted (limit_reached), credentials_required, disconnected or none disconnected
 * (session_invalid); any other code none.
 */
export function healthSignalOf(code: string, details?: unknown): ErrorSignal | null {
  if (code === linkedin_limit_reached) return { signal: "restricted", trigger: "limit_reached" };
  if (code !== linkedin_account_disconnected) return null;
  const reason =
    typeof details === "object" && details !== null ? Reflect.get(details, "reason") : undefined;
  if (reason === "checkpoint") return { signal: "checkpoint", trigger: "checkpoint" };
  if (reason === "restricted") return { signal: "restricted", trigger: "limit_reached" };
  return { signal: "disconnected", trigger: "session_invalid" };
}

/**
 * A port error the run has just logged for the account, at `at`: its signal through applyHealth, or
 * a rate limit's or a provider error's count (pauseOnThirdError). The retry_at the third error set,
 * else null.
 */
export async function afterPortError(
  accountId: string,
  error: unknown,
  at: Date,
): Promise<Date | null> {
  const code = outcomeOf(error);
  const found = healthSignalOf(code, isAppError(error) ? error.details : undefined);
  if (found !== null) {
    const cause = { at, trigger: found.trigger };
    await applyHealth(tenantClient, accountId, found.signal, cause);
    return null;
  }
  return PROVIDER_ERROR_CODES.includes(code) ? pauseOnThirdError(accountId, at) : null;
}

/**
 * With PROVIDER_ERRORS_PER_HOUR_MAX distinct calls or more answered by a rate limit or a provider
 * error for the account in the window back from `at`, its own row included, retry_at moves to the
 * start of its next working day in its zone, never earlier, with one health event: trigger
 * rate_limit_errors, the state as it is, and the count of calls; already paused until then, nothing.
 * A call is its rows' `call_ref`, so the attempts of one read or one send count once; a row without
 * one (a status check, a check's read) is its own call. Under the account's lock, so two errors at
 * once give one event.
 */
export async function pauseOnThirdError(accountId: string, at: Date): Promise<Date | null> {
  const account = await lockAccount(tenantClient, accountId);
  if (account === null) return null;
  const rows = await tenantClient.senderActionLog.findMany({
    where: {
      senderAccountId: accountId,
      outcome: { in: [...PROVIDER_ERROR_CODES] },
      at: { gt: new Date(at.getTime() - PROVIDER_ERROR_WINDOW_MS), lte: at },
    },
    select: { id: true, callRef: true },
  });
  const errors = new Set(rows.map((row) => row.callRef ?? row.id)).size;
  if (errors < PROVIDER_ERRORS_PER_HOUR_MAX) return null;
  const until = nextWorkingDayAt(at, account.timeZone);
  if (account.retryAt !== null && account.retryAt >= until) return null;
  await tenantClient.senderAccount.update({ where: { id: accountId }, data: { retryAt: until } });
  await recordHealthEvent(tenantClient, accountId, {
    from: account.healthState,
    to: account.healthState,
    trigger: "rate_limit_errors",
    metrics: { errors, windowMinutes: PROVIDER_ERROR_WINDOW_MINUTES },
    action: "paused_all_actions",
    pausedUntil: until,
    ackRequired: false,
    at,
    announce: true,
  });
  return until;
}

/** The start of the next working day after `at`, Monday to Friday, in the zone: its quota day's start. */
export function nextWorkingDayAt(at: Date, timeZone: string): Date {
  const next = addBusinessDays(at, 1, timeZone, MONDAY_TO_FRIDAY);
  return instantAt(quotaDay(next, timeZone), QUOTA_DAY_START, timeZone);
}
