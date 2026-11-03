// Unit tests: the retry policy by activity kind, the provider's own delay, the schedule id
// derivation and a row's schedule's calendar.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "@whytide/platform";
import { scheduleId } from "../src/modules.ts";
import { ACTIVITY_ATTEMPTS, retries, retryDelayMs } from "../src/retry.ts";
import { calendarOf } from "../src/scheduler.ts";

test("a provider activity gets five attempts, an ai or db one three; the five codes are never retried", () => {
  assert.deepEqual(ACTIVITY_ATTEMPTS, { provider: 5, ai: 3, db: 3 });
  for (const [kind, attempts] of Object.entries(ACTIVITY_ATTEMPTS)) {
    const k = kind as keyof typeof ACTIVITY_ATTEMPTS;
    assert.equal(retries(k, "llm_rate_limited", attempts - 1), true);
    assert.equal(retries(k, "llm_rate_limited", attempts), false);
  }
  const never = [
    "llm_invalid_key",
    "llm_input_invalid",
    "ai_input_invalid",
    "ai_budget_exceeded",
    "cost_price_missing",
  ];
  for (const code of never) assert.equal(retries("provider", code, 1), false, code);
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
