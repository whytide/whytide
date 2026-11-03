// The weekly review summary (docs/concepts.md "The weekly rate"), pure: an ISO week's instants, the
// week's top twenty qualified leads by fit and their good-lead rate, the number the alpha is judged
// on, and the week's decisions counted by the latest per lead.
import { REASON_CODES, type ReasonCode, type ReviewDecisionKind } from "./rules.ts";

const DAY = 86_400_000;
const TOP = 20;

/** A qualified lead of the week: its fit and its latest decision, whenever made. */
export type WeekLead = {
  readonly personId: string;
  readonly fitScore: number | null;
  readonly reviewStatus: ReviewDecisionKind | null;
};
/** A decision made during the week. */
export type WeekDecision = {
  readonly id: string;
  readonly personId: string;
  readonly decision: ReviewDecisionKind;
  readonly reasonCode: ReasonCode | null;
  readonly decidedAt: Date;
};
export type ReviewSummary = {
  decided: number;
  goodLeads: number;
  notAFit: number;
  /** `rate` is goodLeads / count, null without a lead; an unreviewed lead counts as not good. */
  top20: { count: number; goodLeads: number; reviewed: number; rate: number | null };
  byReason: Record<ReasonCode, number>;
};

/** `2026-W43`: its Monday at 00:00 UTC and the next one; null for a week the year does not have. */
export function weekRange(week: string): { start: Date; end: Date } | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (match === null) return null;
  const [year, number] = [Number(match[1]), Number(match[2])];
  // Week 1 holds January 4th; a week is the year's when its Thursday is.
  const fourth = Date.UTC(year, 0, 4);
  const start = fourth - ((new Date(fourth).getUTCDay() + 6) % 7) * DAY + (number - 1) * 7 * DAY;
  if (number < 1 || new Date(start + 3 * DAY).getUTCFullYear() !== year) return null;
  return { start: new Date(start), end: new Date(start + 7 * DAY) };
}

/** The first twenty by descending fit, no score last, ties by descending person id, as the list. */
export function topTwenty<T extends WeekLead>(leads: readonly T[]): T[] {
  const fit = (lead: WeekLead) => lead.fitScore ?? -1;
  const byId = (a: WeekLead, b: WeekLead) => (a.personId < b.personId ? 1 : -1);
  return [...leads].sort((a, b) => fit(b) - fit(a) || byId(a, b)).slice(0, TOP);
}

/**
 * The week's summary: the top twenty of its qualified leads by fit, good when their latest decision
 * is; and its decisions, the latest per lead (by time, then id), counted by kind and reason code.
 */
export function summarize(
  leads: readonly WeekLead[],
  decisions: readonly WeekDecision[],
): ReviewSummary {
  const latest = new Map<string, WeekDecision>();
  const order = (a: WeekDecision, b: WeekDecision) =>
    a.decidedAt.getTime() - b.decidedAt.getTime() || (a.id < b.id ? -1 : 1);
  for (const decision of [...decisions].sort(order)) latest.set(decision.personId, decision);
  const byReason = Object.fromEntries(
    REASON_CODES.map((code) => [code, 0]),
  ) as ReviewSummary["byReason"];
  let goodLeads = 0;
  for (const { decision, reasonCode } of latest.values()) {
    if (decision === "good_lead") goodLeads++;
    else if (reasonCode !== null) byReason[reasonCode]++;
  }
  const top = topTwenty(leads);
  const good = top.filter((lead) => lead.reviewStatus === "good_lead").length;
  const reviewed = top.filter((lead) => lead.reviewStatus !== null).length;
  const top20 = {
    count: top.length,
    goodLeads: good,
    reviewed,
    rate: top.length ? good / top.length : null,
  };
  return { decided: latest.size, goodLeads, notAFit: latest.size - goodLeads, top20, byReason };
}
