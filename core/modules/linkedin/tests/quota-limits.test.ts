// The day's budgets (domain/quota/limits.ts), the business logic under beta-p1-020's acceptance
// criteria 2 and 4: a day's limits drawn from 80 to 100 percent of the targets, rounded down, never
// above the hard maximums, and the read allowance after the sends; what is left of each budget, the
// week's 100 over the six quota days before and the 200; the window left today, west of UTC across
// daylight saving too.
import assert from "node:assert/strict";
import test from "node:test";
import { synthetic } from "@whytide/platform";
import {
  ACTIONS_PER_DAY_MAX,
  DAY_LIMIT_DRAW,
  INVITES_PER_DAY,
  MESSAGES_PER_DAY,
  READS_PER_DAY_MAX,
  WITHDRAWALS_PER_DAY_MAX,
} from "../domain/quota/constants.ts";
import {
  type DayUsage,
  drawDayLimits,
  limitsFor,
  quotaDayBefore,
  windowLeft,
} from "../domain/quota/limits.ts";

const DRAWS = 400;
const SEEDS = [1, 2, 3, 4, 5];
const DAY: DayUsage = {
  inviteLimit: 5,
  invitesReserved: 0,
  invitesCommitted: 0,
  messageLimit: 10,
  messagesReserved: 0,
  messagesCommitted: 0,
  withdrawalsReserved: 0,
  withdrawalsCommitted: 0,
  readAllowance: 100,
  readsReserved: 0,
  readsCommitted: 0,
};
const CAP = { dailyReadCap: 100 };
const OFFICE = { start: "08:30", end: "18:00", days: [1, 2, 3, 4, 5] };
const seeded = (seed: string) => {
  const s = synthetic(seed);
  return { s, random: () => s.int(2 ** 32) / 2 ** 32 };
};
/** A whole number from `low` to `high`. */
const between = (s: ReturnType<typeof synthetic>, low: number, high: number) =>
  low + s.int(high - low + 1);

test("over seeded random targets, the drawn limits stay within 80 to 100 percent of the target, rounded down, every value of that range drawn, never above 25 and 80, nor above a target past them; the read allowance never passes the cap, 100, nor 200 less the limits and 15", () => {
  const drawn = {
    invites: new Map<number, Set<number>>(),
    messages: new Map<number, Set<number>>(),
  };
  const note = (map: Map<number, Set<number>>, target: number, limit: number) =>
    map.set(target, (map.get(target) ?? new Set()).add(limit));
  for (const seed of SEEDS) {
    const { s, random } = seeded(`linkedin-draw-${seed}`);
    for (let i = 0; i < DRAWS; i++) {
      const account = {
        inviteTarget: between(s, INVITES_PER_DAY.start, INVITES_PER_DAY.target),
        messageTarget: between(s, MESSAGES_PER_DAY.start, MESSAGES_PER_DAY.target),
        dailyReadCap: between(s, 1, READS_PER_DAY_MAX),
      };
      const limits = drawDayLimits(account, null, random);
      for (const [target, limit, max, map] of [
        [account.inviteTarget, limits.inviteLimit, INVITES_PER_DAY.max, drawn.invites],
        [account.messageTarget, limits.messageLimit, MESSAGES_PER_DAY.max, drawn.messages],
      ] as const) {
        const range = `${limit} for ${target}`;
        assert.ok(limit >= Math.floor(target * DAY_LIMIT_DRAW.min), range);
        assert.ok(limit <= Math.floor(target * DAY_LIMIT_DRAW.max) && limit <= max, range);
        note(map, target, limit);
      }
      const afterSends =
        ACTIONS_PER_DAY_MAX - limits.inviteLimit - limits.messageLimit - WITHDRAWALS_PER_DAY_MAX;
      assert.ok(limits.readAllowance <= Math.min(account.dailyReadCap, READS_PER_DAY_MAX));
      assert.ok(limits.readAllowance <= afterSends && limits.readAllowance >= 0);
      assert.equal(limits.checkAfter, null);
    }
    // Targets and caps past every bound, as no CHECK allows: the maximums still hold.
    for (let i = 0; i < DRAWS; i++) {
      const account = {
        inviteTarget: s.int(4 * INVITES_PER_DAY.max),
        messageTarget: s.int(4 * MESSAGES_PER_DAY.max),
        dailyReadCap: s.int(10 * READS_PER_DAY_MAX),
      };
      const limits = drawDayLimits(account, null, random);
      assert.ok(limits.inviteLimit <= Math.min(account.inviteTarget, INVITES_PER_DAY.max));
      assert.ok(limits.messageLimit <= Math.min(account.messageTarget, MESSAGES_PER_DAY.max));
      assert.ok(limits.readAllowance <= READS_PER_DAY_MAX);
      const all = limits.inviteLimit + limits.messageLimit + limits.readAllowance;
      assert.ok(all + WITHDRAWALS_PER_DAY_MAX <= ACTIONS_PER_DAY_MAX);
    }
  }
  assert.deepEqual([...(drawn.invites.get(5) ?? [])].sort(), [4, 5]);
  assert.deepEqual([...(drawn.invites.get(15) ?? [])].sort(), [12, 13, 14, 15]);
  assert.deepEqual(
    [...(drawn.messages.get(10) ?? [])].sort((a, b) => a - b),
    [8, 9, 10],
  );
  assert.throws(() => drawDayLimits({ ...CAP, inviteTarget: 5, messageTarget: 10 }, null, () => 1));
});

test("the check's instant is drawn within the first two hours of what is left of today's window, never in its last hour, seeded; the window's start when it leaves no such instant; none without a window", () => {
  const { random } = seeded("linkedin-check-after");
  const at = (time: string) => new Date(`2026-10-22T${time}:00Z`);
  const account = { ...CAP, inviteTarget: 5, messageTarget: 10 };
  const cases = [
    [{ from: at("10:00"), to: at("16:00") }, at("12:00")],
    [{ from: at("10:00"), to: at("11:30") }, at("10:30")],
  ] as const;
  for (const [window, before] of cases) {
    for (let i = 0; i < DRAWS; i++) {
      const { checkAfter } = drawDayLimits(account, window, random);
      assert.ok(checkAfter !== null && checkAfter >= window.from && checkAfter < before);
    }
  }
  const short = { from: at("10:00"), to: at("10:45") };
  assert.deepEqual(drawDayLimits(account, short, random).checkAfter, short.from);
  assert.equal(drawDayLimits(account, null, random).checkAfter, null);
});

test("limitsFor: each budget less what is reserved and made; the week's 100 leaves at most 2 after 98 invites over the six quota days before, whatever the day's limit; reads within the smaller of the allowance and the cap; every budget within the 200 left", () => {
  const used = {
    ...DAY,
    invitesReserved: 1,
    invitesCommitted: 1,
    messagesCommitted: 3,
    withdrawalsReserved: 4,
    readsReserved: 20,
    readsCommitted: 10,
  };
  assert.deepEqual(limitsFor(CAP, used, { invitesBefore: 0 }), {
    invites: 3,
    messages: 7,
    withdrawals: 11,
    reads: 70,
    actions: 161,
  });
  for (let inviteLimit = 0; inviteLimit <= INVITES_PER_DAY.max; inviteLimit++) {
    const { invites } = limitsFor(CAP, { ...DAY, inviteLimit }, { invitesBefore: 98 });
    assert.equal(invites, Math.min(inviteLimit, 2), `limit ${inviteLimit}`);
  }
  const week = { ...DAY, inviteLimit: 15, invitesCommitted: 1 };
  assert.equal(limitsFor(CAP, week, { invitesBefore: 98 }).invites, 1);
  assert.equal(limitsFor(CAP, week, { invitesBefore: 99 }).invites, 0);
  assert.equal(limitsFor(CAP, week, { invitesBefore: 120 }).invites, 0);

  assert.equal(limitsFor({ dailyReadCap: 40 }, used, { invitesBefore: 0 }).reads, 10);
  assert.equal(limitsFor({ dailyReadCap: 20 }, used, { invitesBefore: 0 }).reads, 0);
  assert.equal(limitsFor(CAP, { ...used, readAllowance: 35 }, { invitesBefore: 0 }).reads, 5);

  // The sends a day counted past their limits leave 5 of the 200: no budget passes it.
  const busy = { ...DAY, inviteLimit: 15, messageLimit: 40, messagesCommitted: 195 };
  assert.deepEqual(limitsFor(CAP, busy, { invitesBefore: 0 }), {
    invites: 5,
    messages: 0,
    withdrawals: 5,
    reads: 5,
    actions: 5,
  });
  const full = { ...busy, readsCommitted: 5 };
  const nothing = { invites: 0, messages: 0, withdrawals: 0, reads: 0, actions: 0 };
  assert.deepEqual(limitsFor(CAP, full, { invitesBefore: 0 }), nothing);
});

test("the weekly sum's days: the six quota days before, as dates in order, across a month's end", () => {
  assert.equal(quotaDayBefore("2026-10-22", 6), "2026-10-16");
  assert.equal(quotaDayBefore("2026-03-03", 6), "2026-02-25");
  assert.equal(quotaDayBefore("2027-01-02", 6), "2026-12-27");
});

test("the window left today: from its start, or from now inside it, to its end; none once it ended or on a day off; west of UTC, a start the spring-forward skips opens an hour later", () => {
  const paris = (at: string) => windowLeft(new Date(at), "Europe/Paris", OFFICE);
  const end = new Date("2026-10-22T16:00:00Z"); // Thursday 18:00 in Paris
  assert.deepEqual(paris("2026-10-22T05:00:00Z"), {
    from: new Date("2026-10-22T06:30:00Z"),
    to: end,
  });
  assert.deepEqual(paris("2026-10-22T10:00:00Z"), {
    from: new Date("2026-10-22T10:00:00Z"),
    to: end,
  });
  assert.equal(paris("2026-10-22T16:00:00Z"), null);
  assert.equal(paris("2026-10-24T10:00:00Z"), null); // Saturday
  const early = { start: "02:30", end: "18:00", days: [7] };
  const sunday = windowLeft(new Date("2026-03-08T08:00:00Z"), "America/Los_Angeles", early);
  assert.deepEqual(sunday?.from, new Date("2026-03-08T10:30:00Z")); // 03:30 PDT, not 01:30 PST
});
