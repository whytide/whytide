// The daily plan's rules without a database (beta-p4-010; domain/plan/place.ts, docs/flows.md "The
// daily plan"): which steps keep their times, which are placed again and which are candidates, in what
// order; the capacity of each type and of the actions left; one touch per person a day; and the
// times, a gap from each other and from every kept time, sorted, as many as the window holds, none
// where a spring-forward closes the window. The plan through the database is tests/safety/ and the
// worker's tests/campaigns-plan.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { instantAt, isWindowOpen, synthetic } from "@whytide/platform";
import { MIN_ACTION_GAP_MS } from "../domain/plan/constants.ts";
import { chooseSteps, type PlanStep, placeTimes, sortSteps } from "../domain/plan/place.ts";

const AT = new Date("2026-10-28T10:00:00Z");
const TODAY = "2026-10-28";
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const RANGE = 2 ** 32;
const ROOMY = { invites: 25, messages: 80, withdrawals: 15, actions: 200 };
const NONE = new Set<string>();

const seeded = (seed: string) => {
  const s = synthetic(seed);
  return () => s.int(RANGE) / RANGE;
};
const ago = (ms: number) => new Date(AT.getTime() - ms);
const later = (ms: number) => new Date(AT.getTime() + ms);

/** A scheduled step, due an hour ago and unplaced unless `fields` say otherwise. */
function step(id: string, fields: Partial<PlanStep> = {}): PlanStep {
  const base = { personId: `per_${id}`, actionType: "invite" as const, position: 1 };
  return { id, ...base, dueAt: ago(HOUR_MS), scheduledFor: null, quotaDay: null, ...fields };
}
const placed = (at: Date, day = TODAY) => ({ scheduledFor: at, quotaDay: day });
const idsOf = (steps: readonly PlanStep[]) => steps.map((each) => each.id);

test("sortSteps: a time today ahead of the run, or less than a gap behind, is kept; one more than a gap behind, or yesterday's, is placed again with the due steps; a step not due, or with no due time, is no candidate", () => {
  const steps = [
    step("ahead", placed(later(MINUTE_MS))),
    step("just_behind", placed(ago(MIN_ACTION_GAP_MS - 1))),
    step("a_gap_behind", placed(ago(MIN_ACTION_GAP_MS))),
    step("stale", placed(ago(2 * HOUR_MS))),
    step("yesterday", placed(ago(20 * HOUR_MS), "2026-10-27")),
    step("due_now", { dueAt: AT }),
    step("due_later", { dueAt: later(1) }),
    step("not_anchored", { dueAt: null }),
  ];
  const sorted = sortSteps(steps, AT, TODAY);
  assert.deepEqual(idsOf(sorted.kept), ["ahead", "just_behind"]);
  assert.deepEqual(idsOf(sorted.stale), ["a_gap_behind", "stale", "yesterday"]);
  assert.deepEqual([...idsOf(sorted.candidates)].sort(), [
    "a_gap_behind",
    "due_now",
    "stale",
    "yesterday",
  ]);
});

test("the order: messages, then withdrawals, then invites; within a type by due time, then position, then id", () => {
  const steps = [
    step("i1", { dueAt: ago(3 * HOUR_MS) }),
    step("w1", { actionType: "withdraw" }),
    step("m3", { actionType: "message", dueAt: ago(HOUR_MS), position: 3 }),
    step("m2b", { actionType: "message", dueAt: ago(HOUR_MS), position: 2 }),
    step("m2a", { actionType: "message", dueAt: ago(HOUR_MS), position: 2 }),
    step("m0", { actionType: "message", dueAt: ago(2 * HOUR_MS), position: 4 }),
  ];
  const { candidates } = sortSteps(steps, AT, TODAY);
  assert.deepEqual(idsOf(candidates), ["m0", "m2a", "m2b", "m3", "w1", "i1"]);
});

test("the capacity: when it is short, messages are placed before invites; each type within its number, all within the actions left, which a kept step counts against", () => {
  const candidates = [
    step("m1", { actionType: "message" }),
    step("m2", { actionType: "message" }),
    step("w1", { actionType: "withdraw" }),
    step("i1"),
    step("i2"),
  ];
  const sorted = (kept: PlanStep[]) => ({
    kept,
    candidates: sortSteps(candidates, AT, TODAY).candidates,
  });
  const choose = (kept: PlanStep[], capacity: typeof ROOMY) =>
    idsOf(chooseSteps({ ...sorted(kept), capacity, touched: NONE }).chosen);
  assert.deepEqual(choose([], ROOMY), ["m1", "m2", "w1", "i1", "i2"]);
  assert.deepEqual(choose([], { ...ROOMY, actions: 3 }), ["m1", "m2", "w1"]);
  assert.deepEqual(choose([], { ...ROOMY, messages: 1, invites: 1 }), ["m1", "w1", "i1"]);
  // A kept invite takes one of the two invites and one of the four actions.
  const kept = [step("k1", placed(later(HOUR_MS)))];
  assert.deepEqual(choose(kept, { ...ROOMY, invites: 2, actions: 4 }), ["m1", "m2", "w1"]);
  assert.deepEqual(choose(kept, { ...ROOMY, invites: 2, messages: 0 }), ["w1", "i1"]);
});

test("kept steps past the capacity: the latest lose their time, by type and by the actions left", () => {
  const kept = [
    step("k3", { ...placed(later(3 * HOUR_MS)) }),
    step("k1", { ...placed(later(HOUR_MS)) }),
    step("k2", { ...placed(later(2 * HOUR_MS)), actionType: "message" }),
    step("k4", { ...placed(later(4 * HOUR_MS)), actionType: "message" }),
  ];
  const choose = (capacity: typeof ROOMY) => {
    const chosen = chooseSteps({ kept, candidates: [], capacity, touched: NONE });
    return [idsOf(chosen.kept), idsOf(chosen.dropped)];
  };
  assert.deepEqual(choose(ROOMY), [["k1", "k2", "k3", "k4"], []]);
  assert.deepEqual(choose({ ...ROOMY, invites: 1 }), [["k1", "k2", "k4"], ["k3"]]);
  assert.deepEqual(choose({ ...ROOMY, actions: 2 }), [
    ["k1", "k2"],
    ["k3", "k4"],
  ]);
  assert.deepEqual(choose({ ...ROOMY, messages: 0, invites: 0 }), [[], ["k1", "k2", "k3", "k4"]]);
});

test("the touch rule: a person with a kept step today, or touched today, gets no new step; of a person's candidates only the first is taken, even when its type has no room", () => {
  const kept = [step("k1", { ...placed(later(HOUR_MS)), personId: "per_a" })];
  const candidates = sortSteps(
    [
      step("a_message", { personId: "per_a", actionType: "message" }),
      step("b_invite", { personId: "per_b" }),
      step("c_message", { personId: "per_c", actionType: "message" }),
      step("c_invite", { personId: "per_c" }),
      step("d_withdraw", { personId: "per_d", actionType: "withdraw" }),
      step("d_invite", { personId: "per_d" }),
    ],
    AT,
    TODAY,
  ).candidates;
  const touched = new Set(["per_b"]);
  const chosen = chooseSteps({ kept, candidates, capacity: ROOMY, touched }).chosen;
  assert.deepEqual(idsOf(chosen), ["c_message", "d_withdraw"]);
  // per_d's withdrawal has no room: its invite still waits for another day.
  const tight = { ...ROOMY, withdrawals: 0 };
  assert.deepEqual(idsOf(chooseSteps({ kept, candidates, capacity: tight, touched }).chosen), [
    "c_message",
  ]);
});

test("placeTimes: times in [from, to), sorted, the first items taking the earliest, never within a gap of each other or of a kept time, before it or after it", () => {
  const from = AT;
  const to = later(2 * HOUR_MS);
  const kept = [ago(MIN_ACTION_GAP_MS / 2), later(30 * MINUTE_MS), later(30 * MINUTE_MS + 50_000)];
  const items = Array.from({ length: 40 }, (_, index) => `item_${index}`);
  for (let seed = 1; seed <= 50; seed += 1) {
    const random = seeded(`plan-place-${seed}`);
    const times = placeTimes({ items, from, to, kept, random, open: () => true });
    assert.equal(times.length, items.length, `seed ${seed}: every item fits`);
    assert.deepEqual(
      times.map(({ item }) => item),
      items,
      `seed ${seed}: the items in their order`,
    );
    const all = [...times.map(({ at }) => at.getTime()), ...kept.map((at) => at.getTime())];
    for (const { at } of times) {
      assert.ok(from <= at && at < to, `seed ${seed}: ${at.toISOString()} outside [from, to)`);
    }
    for (let i = 1; i < times.length; i += 1) {
      assert.ok((times[i]?.at ?? AT) > (times[i - 1]?.at ?? AT), `seed ${seed}: not sorted`);
    }
    const sorted = all.sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      const gap = (sorted[i] ?? 0) - (sorted[i - 1] ?? 0);
      assert.ok(gap >= MIN_ACTION_GAP_MS, `seed ${seed}: two times ${gap} ms apart`);
    }
  }
});

test("a window too short for every candidate: as many as fit get a time, the earliest candidates; an empty or closed window places none", () => {
  const items = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const from = AT;
  const to = new Date(AT.getTime() + 3 * MIN_ACTION_GAP_MS);
  const times = placeTimes({
    items,
    from,
    to,
    kept: [],
    random: seeded("short"),
    open: () => true,
  });
  // [from, from + 3 gaps) holds three times a gap apart: a fourth would need the end itself.
  assert.deepEqual(
    times.map(({ item }) => item),
    ["a", "b", "c"],
  );
  const none = (window: { from: Date; to: Date }, kept: Date[] = []) =>
    placeTimes({ items, ...window, kept, random: seeded("none"), open: () => true });
  assert.deepEqual(none({ from: to, to: from }), []);
  assert.deepEqual(none({ from, to: from }), []);
  // A kept time in the middle of a window shorter than two gaps leaves no instant a gap from it.
  const short = new Date(AT.getTime() + 2 * MIN_ACTION_GAP_MS - 1_000);
  const middle = new Date((AT.getTime() + short.getTime()) / 2);
  assert.deepEqual(none({ from, to: short }, [middle]), []);
  assert.deepEqual(
    placeTimes({ items, from, to, kept: [], random: Math.random, open: () => false }),
    [],
  );
});

test("a window whose end a spring-forward skips: no time is placed where isWindowOpen says the window is closed", () => {
  // Israel moves to summer time on Friday 27 March 2026 at 02:00: 01:00 to 02:30 starts at 01:00
  // and ends at 03:30 summer time, and from 03:00 to 03:30 the window is closed.
  const zone = "Asia/Jerusalem";
  const hours = { start: "01:00", end: "02:30", days: [1, 2, 3, 4, 5] };
  const from = instantAt("2026-03-27", hours.start, zone);
  const to = instantAt("2026-03-27", hours.end, zone);
  const summer = new Date("2026-03-27T00:00:00Z"); // 03:00 summer time
  assert.equal(isWindowOpen(new Date(summer.getTime() - 1), zone, hours), true);
  assert.equal(isWindowOpen(summer, zone, hours), false);
  assert.ok(summer < to);
  const items = Array.from({ length: 100 }, (_, index) => `item_${index}`);
  const open = (at: Date) => isWindowOpen(at, zone, hours);
  const times = placeTimes({ items, from, to, kept: [], random: seeded("spring"), open });
  assert.ok(times.length > 0 && times.length < items.length, `${times.length} placed`);
  for (const { at } of times) assert.ok(open(at), `${at.toISOString()}: the window is closed`);
  assert.deepEqual(
    times.map(({ item }) => item),
    items.slice(0, times.length),
  );
});
