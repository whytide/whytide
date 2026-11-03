// contacts' review commands (README.md "Public interface"), inside the caller's tenant run like
// every command of contacts (../persons.ts): a decision appended to a lead's, the lead's history,
// and a week's summary. Nothing updates or deletes a decision; erasePerson alone deletes a
// person's.
import { outboxWriter, tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId, publish } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { ids } from "../../ids.ts";
import type { Tier } from "../lead.ts";
import { parseInput, requireId } from "../rules.ts";
import { type DecisionFields, decisionFields, type ReasonCode, reviewInput } from "./rules.ts";
import { type ReviewSummary, summarize, weekRange } from "./summary.ts";

export type ReviewDecision = DecisionFields & {
  readonly id: string;
  readonly workspaceId: string;
  readonly personId: string;
  /** The lead's score snapshot, fit and tier when the decision was made. */
  readonly snapshotId: string | null;
  readonly fitAtDecision: number | null;
  readonly tierAtDecision: Tier | null;
  /** The principal's user id. */
  readonly decidedBy: string;
  readonly decidedAt: Date;
};

/**
 * Appends the decision (rules.ts) with the lead's snapshot, fit and tier of now, and makes it the
 * lead's latest; publishes contacts.lead_reviewed. lead_not_found.
 */
export async function reviewLead(input: {
  personId: string;
  decision: DecisionFields["decision"];
  reasonCode?: ReasonCode;
  reasonText?: string;
  goodReasonText?: string;
}): Promise<ReviewDecision> {
  const { personId, ...given } = parseInput(reviewInput, input);
  const fields = decisionFields(given);
  const select = { currentScoreSnapshotId: true, fitScore: true, tier: true } as const;
  const lead = await tenantClient.lead.findFirst({ where: { personId }, select });
  if (lead === null) throw new AppError(errors.lead_not_found);
  const { workspaceId, principal } = currentTenant();
  const decidedAt = new Date();
  const row = await tenantClient.reviewDecision.create({
    data: {
      ...fields,
      id: newId(ids.review_decision),
      workspaceId,
      personId,
      snapshotId: lead.currentScoreSnapshotId,
      fitAtDecision: lead.fitScore,
      tierAtDecision: lead.tier,
      decidedBy: principal.userId,
      decidedAt,
    },
  });
  // Raw, so that updated_at, which the list shows as the time of qualification, stays; and a later
  // decision that committed first stays the latest.
  await tenantClient.$executeRaw`
    UPDATE leads SET review_status = ${fields.decision}::review_decision, reviewed_at = ${decidedAt}
    WHERE workspace_id = ${workspaceId} AND person_id = ${personId}
      AND (reviewed_at IS NULL OR reviewed_at <= ${decidedAt})`;
  const payload = { workspaceId, personId, decision: fields.decision };
  await publish(outboxWriter(tenantClient, workspaceId), events["contacts.lead_reviewed"], payload);
  return row as ReviewDecision;
}

/** The lead's decisions, newest first, the hundred newest at most. lead_not_found. */
export async function listReviews(personId: string): Promise<ReviewDecision[]> {
  const id = requireId("personId", personId);
  const lead = await tenantClient.lead.findFirst({
    where: { personId: id },
    select: { personId: true },
  });
  if (lead === null) throw new AppError(errors.lead_not_found);
  const rows = await tenantClient.reviewDecision.findMany({
    where: { personId: id },
    orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
    take: 100,
  });
  return rows as ReviewDecision[];
}

/** A lead's latest decision, as the exports read it: no workspace, author or id of its own. */
export type LatestReview = DecisionFields & {
  readonly personId: string;
  /** The lead's score snapshot when the decision was made. */
  readonly snapshotId: string | null;
  readonly decidedAt: Date;
};

/**
 * Each reviewed lead's latest decision, by person id; with `week`, an ISO week, only the leads whose
 * latest decision was made in it, so that a lead decided again later leaves the earlier week.
 * contacts_input_invalid naming `week` for a week the year does not have.
 */
export async function latestReviews(input: { week?: string } = {}): Promise<LatestReview[]> {
  const range = input.week === undefined ? undefined : weekOf(input.week);
  const reviewedAt = range ? { gte: range.start, lt: range.end } : { not: null };
  const leads = await tenantClient.lead.findMany({
    where: { reviewedAt },
    select: { personId: true },
    orderBy: { personId: "asc" },
  });
  return [...(await latestOf(leads.map((lead) => lead.personId))).values()];
}

/** The latest decision of each lead named that has one (by decided_at, then id), by person id. */
export async function latestOf(personIds: readonly string[]): Promise<Map<string, LatestReview>> {
  if (personIds.length === 0) return new Map();
  const rows = await tenantClient.reviewDecision.findMany({
    where: { personId: { in: [...personIds] } },
    distinct: ["personId"],
    orderBy: [{ personId: "asc" }, { decidedAt: "desc" }, { id: "desc" }],
    select: {
      personId: true,
      decision: true,
      reasonCode: true,
      reasonText: true,
      goodReasonText: true,
      snapshotId: true,
      decidedAt: true,
    },
  });
  return new Map((rows as LatestReview[]).map((row) => [row.personId, row]));
}

/**
 * The ISO week's summary (summary.ts): its qualified leads by their `created_at`, its decisions by
 * their `decided_at`. contacts_input_invalid naming `week` for a week the year does not have.
 */
export async function reviewSummary(week: string): Promise<ReviewSummary> {
  const range = weekOf(week);
  const during = { gte: range.start, lt: range.end };
  const leads = await tenantClient.lead.findMany({
    where: { qualificationStatus: "qualified", createdAt: during },
    select: { personId: true, fitScore: true, reviewStatus: true },
  });
  const decisions = await tenantClient.reviewDecision.findMany({
    where: { decidedAt: during },
    select: { id: true, personId: true, decision: true, reasonCode: true, decidedAt: true },
  });
  return summarize(leads, decisions);
}

/** The week's instants, or contacts_input_invalid naming `week`. */
function weekOf(week: string): { start: Date; end: Date } {
  const range = weekRange(week);
  if (range === null) {
    throw new AppError(errors.contacts_input_invalid, { details: { fields: ["week"] } });
  }
  return range;
}
