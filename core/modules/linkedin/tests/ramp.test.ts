// rampStep, the ramp's rules (beta-p1-080; docs/concepts.md "Ramp"), pure: one test per rule, the
// idle restart's rounding and bounds, the restart of an account that cannot act (asked before rule 1,
// a fall only), the health rule (beta-p6-010), and a month of quota days with a connection request
// and a message committed on each, from 5 and 10 to 15 on the 10th day and 40 on the 12th.
import assert from "node:assert/strict";
import test from "node:test";
import type { Controls } from "../domain/controls/controls.ts";
import { INVITES_PER_DAY, MESSAGES_PER_DAY } from "../domain/quota/constants.ts";
import { quotaDayBefore } from "../domain/quota/limits.ts";
import {
  RAMP_EVERY_DAYS,
  RAMP_IDLE_DAYS,
  RAMP_INVITE_STEP,
  RAMP_MESSAGE_STEP,
} from "../domain/ramp/constants.ts";
import { type DaySends, type RampAccount, rampStep } from "../domain/ramp/ramp.ts";

const OPEN: Controls = {
  platform: { sendingOpen: true, stopped: false, invitesPaused: false },
  workspace: { stopped: false, stopSource: null },
};
const TODAY = "2026-11-16";
/** The quota day `days` after TODAY, before it when negative. */
const day = (days: number) => quotaDayBefore(TODAY, -days);
/** An account that can send, at its start, last moved two quota days ago. */
const ACCOUNT: RampAccount = {
  status: "connected",
  healthState: "healthy",
  killSwitch: false,
  controls: OPEN,
  inviteTarget: INVITES_PER_DAY.start,
  messageTarget: MESSAGES_PER_DAY.start,
  rampUpdatedOn: day(-RAMP_EVERY_DAYS),
};
/** A connection request and a message committed on each of the quota days given. */
const both = (...days: number[]): DaySends[] =>
  days.map((at) => ({ quotaDay: day(at), invites: 1, messages: 1 }));

test("the ramp's numbers are the sources' standard tier: a step every 2 quota days, +2 connection requests and +5 messages, a restart after 14 idle quota days", () => {
  assert.deepEqual(
    [RAMP_EVERY_DAYS, RAMP_INVITE_STEP, RAMP_MESSAGE_STEP, RAMP_IDLE_DAYS],
    [2, 2, 5, 14],
  );
  assert.deepEqual(
    [
      INVITES_PER_DAY.start,
      INVITES_PER_DAY.target,
      MESSAGES_PER_DAY.start,
      MESSAGES_PER_DAY.target,
    ],
    [5, 15, 10, 40],
  );
});

test("rule 1: sending closed, the platform, the workspace or the account stopped, the account not connected, or its health not healthy: no rise when due a step; idle, rule 2 still halves 15 and 40 to 7 and 20, and leaves 5 and 10 with the day as it was", () => {
  const blocked: RampAccount[] = [
    { ...ACCOUNT, controls: { ...OPEN, platform: { ...OPEN.platform, sendingOpen: false } } },
    { ...ACCOUNT, controls: { ...OPEN, platform: { ...OPEN.platform, stopped: true } } },
    { ...ACCOUNT, controls: { ...OPEN, workspace: { stopped: true, stopSource: "tester" } } },
    { ...ACCOUNT, killSwitch: true },
    ...(["pending", "credentials_required", "error", "disconnected"] as const).map((status) => ({
      ...ACCOUNT,
      status,
    })),
    ...(["at_risk", "restricted", "checkpoint", "disconnected"] as const).map((healthState) => ({
      ...ACCOUNT,
      healthState,
    })),
  ];
  for (const account of blocked) {
    const label = JSON.stringify(account);
    assert.equal(rampStep(account, TODAY, both(-1)), null, label);
    const full = { ...account, inviteTarget: 15, messageTarget: 40 };
    const halved = { inviteTarget: 7, messageTarget: 20, rampUpdatedOn: TODAY };
    assert.deepEqual(rampStep(full, TODAY, []), halved, `idle 14 days: halved, ${label}`);
    assert.equal(rampStep({ ...full, ...halved }, TODAY, []), null, `a repeat, ${label}`);
    assert.equal(rampStep(account, TODAY, []), null, `idle at the start: the day kept, ${label}`);
  }
  // The invites' pause is not a stop: messages still ramp; no connection request was committed.
  const paused = { ...OPEN, platform: { ...OPEN.platform, invitesPaused: true } };
  const sends = [{ quotaDay: day(-1), invites: 0, messages: 3 }];
  assert.deepEqual(rampStep({ ...ACCOUNT, controls: paused }, TODAY, sends), {
    inviteTarget: 5,
    messageTarget: 15,
    rampUpdatedOn: TODAY,
  });
});

test("rule 2: no committed send in the 14 quota days before today: 15 and 40 restart at 7 and 20 (half, rounded down), 6 and 12 stay, 5 and 10 stay, the day becomes today; a repeat changes nothing", () => {
  const idle = (inviteTarget: number, messageTarget: number, sends: DaySends[] = []) =>
    rampStep({ ...ACCOUNT, inviteTarget, messageTarget, rampUpdatedOn: day(-30) }, TODAY, sends);
  assert.deepEqual(idle(15, 40), { inviteTarget: 7, messageTarget: 20, rampUpdatedOn: TODAY });
  assert.deepEqual(idle(9, 25), { inviteTarget: 7, messageTarget: 20, rampUpdatedOn: TODAY });
  assert.deepEqual(idle(6, 12), { inviteTarget: 6, messageTarget: 12, rampUpdatedOn: TODAY });
  assert.deepEqual(idle(5, 10), { inviteTarget: 5, messageTarget: 10, rampUpdatedOn: TODAY });
  // A send 15 quota days ago is outside the 14; one today is not before today.
  const outside = [...both(-RAMP_IDLE_DAYS - 1), ...both(0)];
  assert.deepEqual(idle(15, 40, outside), {
    inviteTarget: 7,
    messageTarget: 20,
    rampUpdatedOn: TODAY,
  });
  // Restarted already today: the repeat changes nothing; nor for an account never ramped, idle.
  const restarted = { ...ACCOUNT, inviteTarget: 7, messageTarget: 20, rampUpdatedOn: TODAY };
  assert.equal(rampStep(restarted, TODAY, []), null);
  const fresh = { ...ACCOUNT, rampUpdatedOn: null };
  const first = rampStep(fresh, TODAY, []);
  assert.deepEqual(first, { inviteTarget: 5, messageTarget: 10, rampUpdatedOn: TODAY });
  assert.equal(rampStep({ ...fresh, ...first }, TODAY, []), null);
  // A send 14 quota days ago keeps the account from idling.
  assert.equal(idle(15, 40, both(-RAMP_IDLE_DAYS)), null);
});

test("rule 3: never moved, with sends behind it: the day becomes today, and no target rises", () => {
  const never = { ...ACCOUNT, rampUpdatedOn: null };
  assert.deepEqual(rampStep(never, TODAY, both(-3, -2, -1)), {
    inviteTarget: 5,
    messageTarget: 10,
    rampUpdatedOn: TODAY,
  });
});

test("rule 4: fewer than 2 quota days since the last step: no change, also with sends since; a last step ahead of today (a zone moved west) too", () => {
  for (const since of [0, 1]) {
    const recent = { ...ACCOUNT, rampUpdatedOn: day(-since) };
    assert.equal(rampStep(recent, TODAY, both(-1, 0)), null, `${since} days`);
  }
  assert.equal(rampStep({ ...ACCOUNT, rampUpdatedOn: day(1) }, TODAY, both(-1, 0)), null);
});

test("rule 5: each target a step up when a send of its type was committed on a quota day after the last step, today's included; one that sent only messages keeps its connection requests; none on or before the last step's day", () => {
  const step = { inviteTarget: 7, messageTarget: 15, rampUpdatedOn: TODAY };
  assert.deepEqual(rampStep(ACCOUNT, TODAY, both(-1)), step);
  // Today's sends count since the last step; a send within the 14 keeps the account from idling.
  assert.deepEqual(rampStep(ACCOUNT, TODAY, both(-10, 0)), step);
  const messagesOnly = [{ quotaDay: day(-1), invites: 0, messages: 2 }];
  assert.deepEqual(rampStep(ACCOUNT, TODAY, messagesOnly), {
    inviteTarget: 5,
    messageTarget: 15,
    rampUpdatedOn: TODAY,
  });
  const invitesOnly = [{ quotaDay: day(-1), invites: 1, messages: 0 }];
  assert.deepEqual(rampStep(ACCOUNT, TODAY, invitesOnly), {
    inviteTarget: 7,
    messageTarget: 10,
    rampUpdatedOn: TODAY,
  });
  // Sends on the last step's day and before it, within the 14: not since the last step.
  assert.equal(rampStep(ACCOUNT, TODAY, both(-RAMP_EVERY_DAYS, -5)), null);
  // An empty day counts nothing.
  const empty = [...both(-5), { quotaDay: day(-1), invites: 0, messages: 0 }];
  assert.equal(rampStep(ACCOUNT, TODAY, empty), null);
});

test("rule 5's bounds: a step stops at 15 and 40; at both, no change and the day stays; at one, only the other rises", () => {
  const near = { ...ACCOUNT, inviteTarget: 14, messageTarget: 38 };
  assert.deepEqual(rampStep(near, TODAY, both(-1)), {
    inviteTarget: 15,
    messageTarget: 40,
    rampUpdatedOn: TODAY,
  });
  const full = { ...ACCOUNT, inviteTarget: 15, messageTarget: 40 };
  assert.equal(rampStep(full, TODAY, both(-1)), null);
  const invitesFull = { ...ACCOUNT, inviteTarget: 15, messageTarget: 30 };
  assert.deepEqual(rampStep(invitesFull, TODAY, both(-1)), {
    inviteTarget: 15,
    messageTarget: 35,
    rampUpdatedOn: TODAY,
  });
});

test("a connection request and a message committed every quota day from 5 and 10: a step every 2 days by 2 and 5, 15 on the 10th day, 40 on the 12th, never past them; a second answer the same day is no change", () => {
  let account: RampAccount = { ...ACCOUNT, rampUpdatedOn: null };
  const sends: DaySends[] = [];
  const targets: [number, number][] = [];
  for (let n = 0; n <= 20; n += 1) {
    const today = day(n);
    const change = rampStep(account, today, sends);
    if (change !== null) account = { ...account, ...change };
    assert.equal(rampStep(account, today, sends), null, `day ${n}: the repeat`);
    targets.push([account.inviteTarget, account.messageTarget]);
    sends.push({ quotaDay: today, invites: 1, messages: 1 }); // the day's, after the run
  }
  assert.deepEqual(targets.slice(0, 13), [
    [5, 10],
    [5, 10],
    [7, 15],
    [7, 15],
    [9, 20],
    [9, 20],
    [11, 25],
    [11, 25],
    [13, 30],
    [13, 30],
    [15, 35],
    [15, 35],
    [15, 40],
  ]);
  for (const [invites, messages] of targets.slice(12))
    assert.deepEqual([invites, messages], [15, 40]);
});
