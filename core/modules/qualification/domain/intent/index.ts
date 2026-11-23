// intent-v1 (README "Intent and priority"; RB-5.3.1, RB-5.3.2, F04 §5, §7, §8): the intent from the
// signal reader's items, the priority from the fit and the intent, the tier from the priority, and
// the why-now bullet. Pure, the time passed in. No words reach it: an item is ids, codes, numbers and
// a date. Changing a rule or a number here is a new scorer version with its own golden file
// (tests/fixtures/golden/), never an edit of intent-v1.json.
import type { WhyBullet } from "@whytide/contacts";
import type { ScoreStatus, Tier } from "../score/index.ts";
import {
  BOOST_HOURS,
  BOOST_MIN_WEIGHT,
  BOOST_POINTS,
  type CountedRole,
  DAY_MS,
  FIRST_PARTY_KINDS,
  FIT_SHARE_PERCENT,
  HALF_LIFE_DAYS,
  HOT_PRIORITY,
  HOUR_MS,
  HUNDREDTHS,
  INTENT_CLASS_MULTIPLIERS,
  INTENT_HORIZON_DAYS,
  INTENT_SATURATION,
  INTENT_SCALE,
  INTENT_SHARE_PERCENT,
  INTENT_WEIGHTS,
  type IntentClass,
  type IntentKind,
  type IntentRole,
  PERCENT,
  PRIORITY_MAX,
  RELEVANCE_MAX,
  RELEVANCE_MIN,
  REPOST_COUNTS_AS,
  STACKING_MAX,
  STACKING_STEP,
  STACKING_WINDOW_DAYS,
  UNRATED_MULTIPLIER,
  UNRATED_RELEVANCE,
  WARM_PRIORITY,
  WHY_MAX,
} from "./constants.ts";

/** What intent-v1 reads of a signal reader's item. */
export type IntentItem = {
  readonly eventId: string;
  readonly kind: IntentKind;
  readonly role: IntentRole;
  readonly relevance: number | null;
  readonly intentClass: IntentClass | null;
  readonly occurredAt: Date;
};
/** One item's share, as intent_breakdown stores it: an id, codes and a number. */
export type IntentPart = {
  readonly eventId: string;
  readonly kind: IntentKind;
  readonly role: CountedRole;
  /** Its term of S, before the stacking bonus, in hundredths. */
  readonly contribution: number;
};
export type Intent = {
  /** 0 to 100. */
  readonly intent: number;
  /** S, the stacking bonus applied. */
  readonly strength: number;
  /** The items that count, strongest first; ties newest first, then by event id. */
  readonly breakdown: readonly IntentPart[];
  /** The strongest item's bullet `qualification.why.why_now` `{ kind, role, days }`; null for none. */
  readonly whyNow: WhyBullet | null;
  readonly whyNowEventId: string | null;
  /** When the boost ends: BOOST_HOURS after the newest boosting item; null when none boosts. */
  readonly boostUntil: Date | null;
};
export type ScoredIntent = Intent & { readonly priority: number };

const WHY_NOW = "qualification.why.why_now";
/** The fit's bullet, quoting the model or naming a member's verdict. */
const WHY_FIT: ReadonlySet<string> = new Set([
  "qualification.why.fit",
  "qualification.why.fit_member",
]);
const WHY_GAP = "qualification.why.gap";

/**
 * S = Σ base weight × relevance × class multiplier × 0.5^(age ÷ half-life) over the items of the last
 * INTENT_HORIZON_DAYS, × the stacking bonus; Intent = round(100 × (1 − e^(−S ÷ 8))). An item dated
 * after `at` is as old as `at`. An item whose kind or role has no weight, or whose date is invalid,
 * counts for nothing.
 */
export function computeIntent(items: readonly IntentItem[], at: Date): Intent {
  const now = at.getTime();
  const counted = items.flatMap((item) => {
    const role: CountedRole = item.role === "repost" ? REPOST_COUNTS_AS : item.role;
    const weight = INTENT_WEIGHTS[item.kind]?.[role] ?? 0;
    const occurred = Math.min(item.occurredAt.getTime(), now);
    const age = now - occurred;
    // An invalid date is no age, and counts for nothing either.
    if (!(weight > 0) || !(age <= INTENT_HORIZON_DAYS * DAY_MS)) return [];
    const decay = 0.5 ** (age / (HALF_LIFE_DAYS[item.kind] * DAY_MS));
    const term = weight * relevanceOf(item) * multiplierOf(item) * decay;
    return [{ item, role, weight, occurred, age, term }];
  });
  const recent = counted.filter(({ age }) => age <= STACKING_WINDOW_DAYS * DAY_MS);
  const kinds = new Set(recent.map(({ item }) => item.kind));
  const strength = stacking(kinds.size) * counted.reduce((sum, { term }) => sum + term, 0);
  const intent = Math.round(INTENT_SCALE * (1 - Math.exp(-strength / INTENT_SATURATION)));
  const ordered = [...counted].sort(
    (a, b) =>
      b.term - a.term ||
      b.occurred - a.occurred ||
      (a.item.eventId < b.item.eventId ? -1 : a.item.eventId > b.item.eventId ? 1 : 0),
  );
  const breakdown = ordered.map(({ item, role, term }) => ({
    eventId: item.eventId,
    kind: item.kind,
    role,
    contribution: Math.round(term * HUNDREDTHS) / HUNDREDTHS,
  }));
  const boosting = counted.filter(
    ({ item, weight, age }) =>
      age < BOOST_HOURS * HOUR_MS &&
      (FIRST_PARTY_KINDS.has(item.kind) || weight >= BOOST_MIN_WEIGHT),
  );
  const newest = Math.max(...boosting.map(({ occurred }) => occurred));
  const boostUntil = boosting.length === 0 ? null : new Date(newest + BOOST_HOURS * HOUR_MS);
  const [strongest] = ordered;
  if (strongest === undefined) {
    return { intent, strength, breakdown, whyNow: null, whyNowEventId: null, boostUntil };
  }
  const { item, role, age } = strongest;
  const params = { kind: item.kind, role, days: Math.floor(age / DAY_MS) };
  const whyNow = { key: WHY_NOW, params };
  return { intent, strength, breakdown, whyNow, whyNowEventId: item.eventId, boostUntil };
}

/** The stacking bonus for `kinds` distinct kinds: 1 for one, +0.15 for each more, 1.6 at most. */
export function stacking(kinds: number): number {
  return 1 + Math.min(STACKING_STEP * Math.max(kinds - 1, 0), STACKING_MAX);
}

/** Priority = round(0.55 × fit + 0.45 × intent), plus 10 while boosted, 100 at most. */
export function computePriority(input: {
  readonly fit: number;
  readonly intent: number;
  readonly boosted: boolean;
}): number {
  const { fit, intent, boosted } = input;
  const priority = Math.round((FIT_SHARE_PERCENT * fit + INTENT_SHARE_PERCENT * intent) / PERCENT);
  return Math.min(PRIORITY_MAX, priority + (boosted ? BOOST_POINTS : 0));
}

/** The intent of the items at `at` and the priority with the fit: a boost holds until boostUntil. */
export function scoreIntent(items: readonly IntentItem[], fit: number, at: Date): ScoredIntent {
  const intent = computeIntent(items, at);
  const boosted = intent.boostUntil !== null;
  return { ...intent, priority: computePriority({ fit, intent: intent.intent, boosted }) };
}

/** Hot from 75, Warm from 55, Cool below. */
export function priorityTier(priority: number): Tier {
  return priority >= HOT_PRIORITY ? "hot" : priority >= WARM_PRIORITY ? "warm" : "cool";
}

/** The lead's tier: the priority's for a qualified or needs_review lead; none for not_qualified. */
export function leadTier(status: ScoreStatus, priority: number): Tier | null {
  return status === "not_qualified" ? null : priorityTier(priority);
}

/**
 * The why with the why-now bullet right after the fit's (before the gap's when there is no fit
 * bullet), WHY_MAX bullets at most: the gap's goes first. A why-now already in `why` is replaced.
 */
export function withWhyNow(why: readonly WhyBullet[], whyNow: WhyBullet | null): WhyBullet[] {
  const base = why.filter(({ key }) => key !== WHY_NOW);
  if (whyNow === null) return base;
  const fit = base.findIndex(({ key }) => WHY_FIT.has(key));
  const gap = base.findIndex(({ key }) => key === WHY_GAP);
  const at = fit >= 0 ? fit + 1 : gap >= 0 ? gap : base.length;
  return [...base.slice(0, at), whyNow, ...base.slice(at)].slice(0, WHY_MAX);
}

function relevanceOf({ relevance }: IntentItem): number {
  if (relevance === null || !Number.isFinite(relevance)) return UNRATED_RELEVANCE;
  return Math.min(Math.max(relevance, RELEVANCE_MIN), RELEVANCE_MAX);
}

function multiplierOf({ intentClass }: IntentItem): number {
  if (intentClass === null) return UNRATED_MULTIPLIER;
  return INTENT_CLASS_MULTIPLIERS[intentClass] ?? UNRATED_MULTIPLIER;
}
