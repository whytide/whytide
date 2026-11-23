// intent-v1 (README "Intent and priority"), pure: the golden file of the scorer version, which fails
// when a result of that version changes; the stacking bonus, the unrated value and the relevance's
// floor; the priority, its boost and its cap; the tiers' bounds; the why-now bullet, worded by its
// message, and its place in the why.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { WhyBullet } from "@whytide/contacts";
import { formatIcu } from "@whytide/platform";
import {
  INTENT_KINDS,
  INTENT_SCORER_VERSION,
  type IntentClass,
  type IntentKind,
  type IntentRole,
} from "../domain/intent/constants.ts";
import {
  computeIntent,
  computePriority,
  type IntentItem,
  leadTier,
  priorityTier,
  scoreIntent,
  stacking,
  withWhyNow,
} from "../domain/intent/index.ts";

const MESSAGES = JSON.parse(
  readFileSync(new URL("../messages/en.json", import.meta.url), "utf8"),
) as Record<string, string>;
type Row = [string, IntentKind, IntentRole, number | null, IntentClass | null, string];
type Golden = {
  scorer: string;
  cases: {
    name: string;
    fit: number;
    at: string;
    items: Row[];
    expected: {
      intent: number;
      strength: number;
      priority: number;
      tier: string;
      boostUntil: string | null;
      whyNow: Record<string, string | number> | null;
      whyNowEventId: string | null;
      breakdown: [string, IntentKind, IntentRole, number][];
    };
  }[];
};
const T0 = new Date("2026-11-02T10:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const itemOf = ([eventId, kind, role, relevance, intentClass, at]: Row): IntentItem => ({
  ...{ eventId, kind, role, relevance, intentClass },
  occurredAt: new Date(at),
});
/** An item rated 1 and `other` unless given, `days` before T0. */
const item = (kind: IntentKind, role: IntentRole, days = 0, more: Partial<IntentItem> = {}) => ({
  eventId: `evt_${kind}_${role}_${days}`,
  ...{ kind, role, relevance: 1, intentClass: "other" as IntentClass },
  occurredAt: new Date(T0.getTime() - days * DAY),
  ...more,
});
const whyNow = (kind: IntentKind, role: string, days: number): WhyBullet => ({
  key: "qualification.why.why_now",
  params: { kind, role, days },
});

test("the golden file: twenty cases give the scorer version's stored results", () => {
  const file = new URL(`./fixtures/golden/${INTENT_SCORER_VERSION}.json`, import.meta.url);
  const golden = JSON.parse(readFileSync(file, "utf8")) as Golden;
  assert.equal(golden.scorer, INTENT_SCORER_VERSION);
  assert.equal(golden.cases.length, 20);
  for (const { name, fit, at, items, expected } of golden.cases) {
    const scored = scoreIntent(items.map(itemOf), fit, new Date(at));
    const { intent, priority, whyNowEventId, breakdown } = scored;
    const boostUntil = expected.boostUntil === null ? null : new Date(expected.boostUntil);
    assert.deepEqual(
      { intent, priority, tier: priorityTier(priority), boostUntil: scored.boostUntil },
      { intent: expected.intent, priority: expected.priority, tier: expected.tier, boostUntil },
      name,
    );
    assert.ok(Math.abs(scored.strength - expected.strength) < 1e-4, `${name}: S`);
    const params = expected.whyNow;
    const why = params === null ? null : { key: "qualification.why.why_now", params };
    assert.deepEqual([scored.whyNow, whyNowEventId], [why, expected.whyNowEventId], name);
    const parts = breakdown.map((p) => [p.eventId, p.kind, p.role, p.contribution]);
    assert.deepEqual(parts, expected.breakdown, name);
  }
});

test("fit 80 and one competitor comment: intent 53 and priority 78, Hot, on its day; 16 days later 29 and 57, Warm", () => {
  const comment = [item("competitor_engagement", "comment")];
  const today = scoreIntent(comment, 80, T0);
  assert.deepEqual([today.intent, today.priority, priorityTier(today.priority)], [53, 78, "hot"]);
  assert.deepEqual(today.boostUntil, new Date(T0.getTime() + 48 * HOUR));
  const later = scoreIntent(comment, 80, new Date(T0.getTime() + 16 * DAY));
  assert.deepEqual([later.intent, later.priority, priorityTier(later.priority)], [29, 57, "warm"]);
  assert.equal(later.boostUntil, null);
});

test("the stacking bonus: two distinct kinds in 30 days multiply S by 1.15, five by 1.60, the most", () => {
  const factors = [1, 2, 3, 4, 5, 6].map((kinds) => Math.round(stacking(kinds) * 100) / 100);
  assert.deepEqual(factors, [1, 1.15, 1.3, 1.45, 1.6, 1.6]);
  const two = [item("topic_engagement", "comment"), item("creator_engagement", "comment", 29)];
  const alone = two.map((one) => computeIntent([one], T0).strength);
  const sum = (alone[0] ?? 0) + (alone[1] ?? 0);
  assert.ok(Math.abs(computeIntent(two, T0).strength - 1.15 * sum) < 1e-9);
  const five = INTENT_KINDS.map((kind) => item(kind, "reaction"));
  const terms = five.reduce((total, one) => total + computeIntent([one], T0).strength, 0);
  assert.ok(Math.abs(computeIntent(five, T0).strength - 1.6 * terms) < 1e-9);
  // A kind seen 31 days ago still counts, decayed, but adds no bonus.
  const old = [item("topic_engagement", "comment"), item("creator_engagement", "comment", 31)];
  const plain = old.reduce((total, one) => total + computeIntent([one], T0).strength, 0);
  assert.ok(Math.abs(computeIntent(old, T0).strength - plain) < 1e-9);
});

test("an unrated item counts at relevance 0.65 and a multiplier of 1; a rated relevance of 0.1 counts at 0.3, of 2 at 1", () => {
  const S = (more: Partial<IntentItem>) =>
    computeIntent([item("topic_engagement", "comment", 0, more)], T0).strength;
  assert.equal(S({ relevance: null, intentClass: null }), 5 * 0.65);
  assert.equal(S({ relevance: null, intentClass: "seeking_recommendation" }), 5 * 0.65 * 1.5);
  assert.equal(S({ relevance: 0.1 }), 5 * 0.3);
  assert.equal(S({ relevance: 2 }), 5);
  assert.equal(S({ relevance: Number.NaN }), 5 * 0.65);
  assert.equal(S({ occurredAt: new Date(Number.NaN) }), 0);
});

test("the priority: 0.55 × fit + 0.45 × intent, rounded, plus 10 while boosted, at most 100", () => {
  assert.equal(computePriority({ fit: 80, intent: 53, boosted: false }), 68);
  assert.equal(computePriority({ fit: 80, intent: 53, boosted: true }), 78);
  assert.equal(computePriority({ fit: 70, intent: 0, boosted: false }), 39);
  assert.equal(computePriority({ fit: 100, intent: 99, boosted: true }), 100);
  assert.equal(computePriority({ fit: 0, intent: 0, boosted: false }), 0);
});

test("the tiers: 74 and 75 give Warm and Hot, 54 and 55 Cool and Warm; a not_qualified lead has none", () => {
  assert.deepEqual([74, 75, 54, 55].map(priorityTier), ["warm", "hot", "cool", "warm"]);
  assert.deepEqual(
    [leadTier("qualified", 75), leadTier("needs_review", 54), leadTier("not_qualified", 90)],
    ["hot", "cool", null],
  );
});

test("the why-now bullet names the strongest item's kind, role and age in days, worded by its message", () => {
  const items = [
    item("topic_engagement", "reaction", 0),
    item("competitor_engagement", "repost", 2, { intentClass: "pain_or_complaint" }),
  ];
  const { whyNow: bullet, whyNowEventId } = computeIntent(items, new Date(T0.getTime() + HOUR));
  assert.deepEqual(bullet, whyNow("competitor_engagement", "reaction", 2));
  assert.equal(whyNowEventId, "evt_competitor_engagement_repost_2");
  const say = (params: Record<string, string | number>) =>
    formatIcu(MESSAGES["qualification.why.why_now"] ?? "", params, "en");
  assert.equal(say(bullet?.params ?? {}), "Reacted to a competitor’s post · 2 days ago");
  assert.equal(
    say({ kind: "my_post_engagement", role: "comment", days: 1 }),
    "Commented on your post · 1 day ago",
  );
  assert.equal(
    say({ kind: "topic_engagement", role: "author", days: 0 }),
    "Posted on a topic you track · today",
  );
  assert.equal(computeIntent([], T0).whyNow, null);
});

test("withWhyNow: right after the fit's bullet, before the gap's without one, three bullets at most", () => {
  const stop = { key: "qualification.why.disqualified", params: { disqualifier: "competitor" } };
  const fit = { key: "qualification.why.fit", params: { criterion: "industry" } };
  const gap = { key: "qualification.why.gap", params: { criterion: "location", more: 0 } };
  const now = whyNow("competitor_engagement", "comment", 3);
  assert.deepEqual(withWhyNow([fit, gap], now), [fit, now, gap]);
  assert.deepEqual(withWhyNow([stop, fit, gap], now), [stop, fit, now]);
  assert.deepEqual(withWhyNow([stop, gap], now), [stop, now, gap]);
  assert.deepEqual(withWhyNow([stop], now), [stop, now]);
  assert.deepEqual(withWhyNow([], now), [now]);
  // A why-now already there is replaced, or taken out when there is none.
  const old = whyNow("topic_engagement", "reaction", 9);
  assert.deepEqual(withWhyNow([fit, old, gap], now), [fit, now, gap]);
  assert.deepEqual(withWhyNow([fit, old, gap], null), [fit, gap]);
});
