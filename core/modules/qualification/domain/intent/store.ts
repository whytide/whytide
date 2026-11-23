// The intent_scores row (README "Intent and priority", docs/data.md): one per lead, in the caller's
// tenant run, written after the lead's tier and why, under the person's advisory lock, which every
// decision takes too (score/score-snapshot.ts, workflows/batch.ts), so that neither overwrites the
// other's fields. The reader's items are read here, outside the pure intent-v1, and each part of the
// breakdown keeps its signal's date and its source's creator (gamma-p5-065): the page's why-now date
// and the Hot alert's recipient. A write tells its caller when it takes the lead into Hot, and one
// that leaves Hot clears the alert's claim (README "The Hot alert"). Ids, codes, numbers and times
// only.
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import type { Tier } from "../score/index.ts";
import { signalReader } from "../signal-reader.ts";
import {
  COUNTED_ROLES,
  DAY_MS,
  HOT_TIER,
  INTENT_HORIZON_DAYS,
  INTENT_KINDS,
  INTENT_SCORER_VERSION,
  LEAD_PRIORITIES_MAX,
  PERSON_LOCK,
} from "./constants.ts";
import { type IntentPart, priorityTier, type ScoredIntent, scoreIntent } from "./index.ts";

/** A scored person's priority and tier, as leadPriorities answers them. */
export type LeadPriority = {
  readonly personId: string;
  readonly priority: number;
  /** Null for a lead without one (not_qualified). */
  readonly tier: Tier | null;
};
/** One part of intent_breakdown as a write stores it: intent-v1's, with its signal's date and owner. */
export type StoredPart = IntentPart & {
  /** When the signal occurred, ISO; never after the computation, as intent-v1 counts it. */
  readonly at: string;
  /** The member who created the signal's source, the reader's ownerUserId; null when none is known. */
  readonly ownerUserId: string | null;
};
/** The intent as a write stores it. */
export type StoredIntent = Omit<ScoredIntent, "breakdown"> & {
  readonly breakdown: readonly StoredPart[];
};
/** A stored part as a read gives it: a row written before gamma-p5-065 has no date or owner. */
export type ReadPart = IntentPart & {
  readonly at: string | null;
  readonly ownerUserId: string | null;
};

const personIds = z.array(z.string().min(1).max(64)).max(LEAD_PRIORITIES_MAX);
const readPart = z.object({
  eventId: z.string().min(1),
  kind: z.enum(INTENT_KINDS),
  role: z.enum(COUNTED_ROLES),
  contribution: z.number(),
  at: z.iso.datetime().nullable().catch(null),
  ownerUserId: z.string().min(1).nullable().catch(null),
});

/** The person's lock until the caller's run ends; taken again in that run, it waits for none. */
export async function lockPerson(personId: string): Promise<void> {
  const key = `${PERSON_LOCK}:${currentTenant().workspaceId}:${personId}`;
  await tenantClient.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/**
 * The person's intent at `at` and the priority with the fit, from the registered reader's items of
 * the last INTENT_HORIZON_DAYS, each part with its item's date and owner; null when no reader is
 * registered.
 */
export async function intentOf(
  personId: string,
  fit: number,
  at: Date,
): Promise<StoredIntent | null> {
  const reader = signalReader();
  if (reader === undefined) return null;
  const since = new Date(at.getTime() - INTENT_HORIZON_DAYS * DAY_MS);
  const items = (await reader.intentInputs({ personIds: [personId], since })).filter(
    (item) => item.personId === personId,
  );
  const scored = scoreIntent(items, fit, at);
  const byEvent = new Map(items.map((item) => [item.eventId, item]));
  const breakdown = scored.breakdown.map((part) => {
    const item = byEvent.get(part.eventId);
    // An item dated after `at` counts as of `at` (computeIntent), so its part is dated so too.
    const occurred = Math.min(item?.occurredAt.getTime() ?? at.getTime(), at.getTime());
    const ownerUserId = item?.ownerUserId ?? null;
    return { ...part, at: new Date(occurred).toISOString(), ownerUserId };
  });
  return { ...scored, breakdown };
}

/**
 * The person's row: the intent computed at `at`, its priority and the lead's tier. True when the
 * write takes the lead into Hot, from no row or a row of another tier: the caller then publishes
 * qualification.lead_hot in its run. A write of another tier clears the Hot alert's claim, so that a
 * later entry alerts again; a write that keeps the lead Hot keeps it.
 */
export async function writeIntent(
  personId: string,
  scored: StoredIntent,
  tier: Tier | null,
  at: Date,
): Promise<boolean> {
  const { workspaceId } = currentTenant();
  const before = await tenantClient.intentScore.findFirst({
    where: { personId },
    select: { tier: true },
  });
  const hot = tier === HOT_TIER;
  const data = {
    intentScore: scored.intent,
    priority: scored.priority,
    tier,
    intentBreakdown: scored.breakdown.map((part) => ({ ...part })),
    whyNowEventId: scored.whyNowEventId,
    boostUntil: scored.boostUntil,
    scorerVersion: INTENT_SCORER_VERSION,
    computedAt: at,
    ...(hot ? {} : { hotAlertedAt: null }),
  };
  await tenantClient.intentScore.upsert({
    where: { workspaceId_personId: { workspaceId, personId } },
    create: { workspaceId, personId, ...data },
    update: data,
  });
  return hot && before?.tier !== HOT_TIER;
}

/**
 * A row's intent_breakdown as stored, in its order: a part of a row written before gamma-p5-065 has
 * no date or owner (null), and one this version cannot read is left out.
 */
export function readParts(breakdown: unknown): ReadPart[] {
  if (!Array.isArray(breakdown)) return [];
  return breakdown.flatMap((part: unknown) => {
    const parsed = readPart.safeParse(part);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The person's row deleted, for a lead with no decision to rank: hard_filtered, ai_failed or gone. */
export async function dropIntent(personId: string): Promise<void> {
  await tenantClient.intentScore.deleteMany({ where: { personId } });
}

/**
 * In the caller's tenant run, one query: each named person's priority and tier, for those with a row,
 * the highest priority first, ties by person id; `[]` for no ids. LEAD_PRIORITIES_MAX ids at most,
 * else qualification_input_invalid.
 */
export async function leadPriorities(ids: readonly string[]): Promise<LeadPriority[]> {
  const parsed = personIds.safeParse(ids);
  if (!parsed.success) {
    throw new AppError(errors.qualification_input_invalid, { details: { fields: ["personIds"] } });
  }
  if (parsed.data.length === 0) return [];
  return tenantClient.intentScore.findMany({
    where: { personId: { in: [...new Set(parsed.data)] } },
    select: { personId: true, priority: true, tier: true },
    orderBy: [{ priority: "desc" }, { personId: "asc" }],
  });
}

/**
 * For other modules' tests (testing/): the person's row with `priority`, its tier and no intent, in
 * the caller's tenant run, whatever the lead. It publishes nothing, whatever the tier.
 */
export async function setLeadPriority(personId: string, priority: number): Promise<void> {
  const scored = { intent: 0, strength: 0, breakdown: [], whyNow: null, priority };
  const none = { whyNowEventId: null, boostUntil: null };
  await writeIntent(personId, { ...scored, ...none }, priorityTier(priority), new Date());
}
