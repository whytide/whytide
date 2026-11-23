// Unit tests: the retry policy by activity kind, an activity's own bound and codes beside it, the
// provider's own delay, the schedule id derivation and a row's schedule's calendar.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVITY_ATTEMPTS, AppError } from "@whytide/platform";
import { scheduleId } from "../src/modules.ts";
import { attemptsOf, NOT_RETRIED, retries, retryDelayMs } from "../src/retry.ts";
import { calendarOf } from "../src/scheduler.ts";

test("a provider activity gets five attempts, an ai or db one three; NOT_RETRIED keeps its eight codes, never retried", () => {
  assert.deepEqual(ACTIVITY_ATTEMPTS, { provider: 5, ai: 3, db: 3 });
  for (const [kind, attempts] of Object.entries(ACTIVITY_ATTEMPTS)) {
    const k = kind as keyof typeof ACTIVITY_ATTEMPTS;
    assert.equal(retries({ kind: k }, "llm_rate_limited", attempts - 1), true);
    assert.equal(retries({ kind: k }, "llm_rate_limited", attempts), false);
  }
  const never = [
    "llm_invalid_key",
    "llm_input_invalid",
    "ai_input_invalid",
    "ai_budget_exceeded",
    "cost_price_missing",
    "activity_input_invalid",
    "activity_attempts_exhausted",
    "activity_not_in_workflow",
  ];
  assert.deepEqual([...NOT_RETRIED], never);
  for (const code of never) assert.equal(retries({ kind: "provider" }, code, 1), false, code);
});

test("an activity's own notRetried codes are never retried and its own attempts bound the rest, under its kind's", () => {
  const mail = { kind: "provider", notRetried: ["mail_rejected", "mail_input_invalid"] } as const;
  for (const code of mail.notRetried) assert.equal(retries(mail, code, 1), false, code);
  const unreachable = [1, 2, 3, 4, 5].map((attempt) => retries(mail, "mail_unreachable", attempt));
  assert.deepEqual(unreachable, [true, true, true, true, false]);
  assert.equal(retries(mail, "llm_invalid_key", 1), false);

  const once = { kind: "provider", attempts: 1 } as const;
  assert.equal(attemptsOf(once), 1);
  assert.equal(retries(once, "mail_unreachable", 1), false);
  assert.equal(retries(once, "activity_failed", 1), false);
  const three = { kind: "provider", attempts: 3 } as const;
  const failed = [1, 2, 3].map((attempt) => retries(three, "linkedin_provider_error", attempt));
  assert.deepEqual(failed, [true, true, false]);

  // Unset, the kind's; above it (a definition that skipped defineActivity), still the kind's.
  assert.equal(attemptsOf({ kind: "db" }), ACTIVITY_ATTEMPTS.db);
  assert.equal(attemptsOf({ kind: "db", attempts: 9 }), ACTIVITY_ATTEMPTS.db);
});

test("a schedule's id is its module's name, a dot and its own id, the same at every start", () => {
  assert.equal(scheduleId("signals", "daily_run"), "signals.daily_run");
});

test("a rate limit's retryAfterSec sets the next attempt's delay, 15 minutes at most; any other failure keeps the backoff", () => {
  const limited = (retryAfterSec: unknown) =>
    new AppError("linkedin_rate_limited", { details: { retryAfterSec } });
  assert.equal(retryDelayMs(limited(60)), 60_000);
  assert.equal(retryDelayMs(limited(86_400)), 900_000);
  for (const other of [limited("60"), limited(0), new AppError("linkedin_provider_error"), 1]) {
    assert.equal(retryDelayMs(other), undefined);
  }
});

test("a row's schedule's instant is a calendar of that second in UTC", () => {
  const at = new Date("2026-10-25T07:08:09.999Z");
  assert.deepEqual(calendarOf(at), {
    year: 2026,
    month: "OCTOBER",
    dayOfMonth: 25,
    hour: 7,
    minute: 8,
    second: 9,
  });
});
