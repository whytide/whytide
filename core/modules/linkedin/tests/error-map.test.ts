// The error map (beta-p1-030; docs/flows.md "The error map") and the hold, unit tests: every code
// of the LinkedIn port has a row; an account code with no reason, or one of the reasons left, maps as
// disconnected; a code off the list as an unmapped one; the rows of the task's table; the table
// frozen; and the hold longer than the worst retry span of a send activity.
import assert from "node:assert/strict";
import test from "node:test";
import { LINKEDIN_DISCONNECT_REASONS, linkedinPort } from "@whytide/providers";
import {
  ACCOUNT_COOLDOWN_MS,
  PROVIDER_ERROR_PAUSE_MS,
  SEND_RESERVATION_MS,
} from "../domain/send/constants.ts";
import { SEND_ERROR_MAP, sendAnswerOf } from "../domain/send/error-map.ts";

const MINUTE_MS = 60_000;

test("every code the LinkedIn port can throw has its own row, success and the two answers before the call too", () => {
  const codes = [...Object.keys(linkedinPort.errors), ...Object.values(linkedinPort.codes)];
  for (const code of codes) {
    assert.ok(Object.hasOwn(SEND_ERROR_MAP, code), `${code} has no row`);
    assert.equal(sendAnswerOf(code), code);
  }
  for (const answer of ["success", "refused_before_call", "committed_repeat"]) {
    assert.equal(sendAnswerOf(answer), answer);
  }
  assert.equal(sendAnswerOf("made_up_code"), "linkedin_error_unmapped");
});

test("linkedin_account_disconnected maps by its reason: checkpoint and restricted pause the account for 72 hours; any other reason, or none, is disconnected", () => {
  const row = (reason?: unknown) =>
    SEND_ERROR_MAP[sendAnswerOf("linkedin_account_disconnected", reason)];
  const disconnected = {
    slot: "release",
    credits: "release",
    step: { status: "rescheduled", notBefore: null },
    account: { health: "disconnected" },
  };
  for (const reason of [undefined, null, "credentials_required", "disconnected", "anything"]) {
    assert.deepEqual(row(reason), disconnected, String(reason));
  }
  for (const health of ["checkpoint", "restricted"] as const) {
    const paused = { health, trigger: null, forMs: 72 * 60 * MINUTE_MS };
    assert.deepEqual(row(health), { ...disconnected, account: paused });
  }
  assert.deepEqual([...LINKEDIN_DISCONNECT_REASONS].sort(), [
    "checkpoint",
    "credentials_required",
    "disconnected",
    "restricted",
  ]);
});

test("the rows of the table: the outcome unknown keeps the slot until the check and pauses the account; a refusal by LinkedIn commits the slot, not the credits; a limit restricts; a defect fails; a refusal before the call waits; a committed repeat is a success", () => {
  const unknown = {
    slot: "keep_until_checked",
    credits: "as_slot",
    step: { status: "executing", checkAfterPauseMs: PROVIDER_ERROR_PAUSE_MS },
    account: { retryAt: "pause", pauseMs: PROVIDER_ERROR_PAUSE_MS, endSession: true },
  };
  for (const code of [
    "linkedin_provider_error",
    "linkedin_output_invalid",
    "linkedin_error_unmapped",
  ]) {
    assert.deepEqual(SEND_ERROR_MAP[sendAnswerOf(code)], unknown, code);
  }
  assert.equal(PROVIDER_ERROR_PAUSE_MS, 60 * MINUTE_MS);
  const map = SEND_ERROR_MAP;
  assert.deepEqual(map.success, {
    slot: "commit",
    credits: "commit",
    step: { status: "succeeded" },
    account: null,
  });
  assert.deepEqual(map.linkedin_rate_limited, {
    slot: "release",
    credits: "release",
    step: { status: "rescheduled", notBefore: "retry_after" },
    account: { retryAt: "retry_after" },
  });
  const refused = {
    slot: "commit",
    credits: "release",
    step: { status: "failed", exit: "send_refused", defect: false },
    account: null,
  };
  assert.deepEqual([map.linkedin_send_refused, map.linkedin_not_found], [refused, refused]);
  assert.deepEqual(map.linkedin_limit_reached, {
    slot: "commit",
    credits: "release",
    step: { status: "rescheduled", notBefore: "resume" },
    account: { health: "restricted", trigger: "limit_reached", forMs: ACCOUNT_COOLDOWN_MS },
  });
  assert.deepEqual(map.linkedin_input_invalid.step, { status: "failed", exit: null, defect: true });
  assert.deepEqual(map.refused_before_call, {
    slot: "release",
    credits: "release",
    step: { status: "rescheduled", notBefore: "retry_at" },
    account: null,
  });
  assert.deepEqual(map.committed_repeat, {
    slot: "already_committed",
    credits: "as_sent_after_check",
    step: { status: "succeeded" },
    account: null,
  });
});

test("the table, its rows and their values are frozen", () => {
  assert.ok(Object.isFrozen(SEND_ERROR_MAP));
  for (const row of Object.values(SEND_ERROR_MAP)) {
    assert.ok(Object.isFrozen(row) && Object.isFrozen(row.step));
    assert.ok(row.account === null || Object.isFrozen(row.account));
  }
});

test("the hold outlasts the worst retry span of a send activity: 5 attempts up to 15 minutes apart, plus 5 timeouts of 2 minutes (core/apps/worker/src/retry.ts)", () => {
  const attempts = 5;
  assert.ok(SEND_RESERVATION_MS > attempts * 15 * MINUTE_MS + attempts * 2 * MINUTE_MS);
  assert.equal(SEND_RESERVATION_MS, 2 * 60 * MINUTE_MS);
});
