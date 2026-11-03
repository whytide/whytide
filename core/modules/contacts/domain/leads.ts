// contacts' lead commands (README.md "Public interface"), inside the caller's tenant run like every
// command of contacts (persons.ts): one lead per person, made by its first source and filled by
// qualification; the list and the read join the person's fields at read time.
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant } from "@whytide/platform";
import { errors } from "../errors.ts";
import {
  type Confidence,
  decodeCursor,
  encodeCursor,
  type LeadCursor,
  type LeadSort,
  type LeadSource,
  mergeSource,
  positionOf,
  QUALIFICATION_STATUSES,
  type QualificationStatus,
  type SourceKind,
  sourceEntry,
  type Tier,
  type WhyBullet,
} from "./lead.ts";
import type { OutreachStatus } from "./outreach/constants.ts";
import { getPerson, type Person } from "./persons.ts";
import { REVIEW_DECISIONS, type ReviewDecisionKind, type ReviewFilter } from "./review/rules.ts";
import {
  applyQualificationInput,
  createLeadInput,
  leadListInput,
  neighboursInput,
  parseInput,
  pendingInput,
  requireId,
} from "./rules.ts";

export type Lead = {
  readonly personId: string;
  readonly workspaceId: string;
  readonly qualificationStatus: QualificationStatus;
  /** The first source's kind. */
  readonly sourceLabel: SourceKind;
  readonly sources: readonly LeadSource[];
  readonly firstSourceAt: Date;
  readonly fitScore: number | null;
  readonly fitConfidence: Confidence | null;
  readonly tier: Tier | null;
  readonly currentScoreSnapshotId: string | null;
  readonly why: readonly WhyBullet[];
  readonly hardFilterReason: string | null;
  readonly statusReason: string | null;
  readonly icpVersionScored: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** The latest review decision and its time; null until the first (review/reviews.ts). */
  readonly reviewStatus: ReviewDecisionKind | null;
  readonly reviewedAt: Date | null;
  /** Where the lead is on the way to outreach; only recordLeadStatus moves it (outreach/status.ts). */
  readonly outreachStatus: OutreachStatus;
  /** A code: why the latest change happened, such as opted_out; null when none was given. */
  readonly outreachReason: string | null;
};
export type LeadWithPerson = Lead & { readonly person: Person };

/**
 * The person's lead, created `pending` by its first source, whose kind is its label; a later source
 * is appended to `sources`, once per kind and ref, and the label and `firstSourceAt` stay. A source
 * the lead has takes the `label` and `url` it brings again (mergeSource). A label or a URL off its
 * rule is contacts_input_invalid naming it, and nothing is written. person_not_found.
 */
export async function createLeadForPerson(input: {
  personId: string;
  source: { kind: SourceKind; ref: string; at?: Date; label?: string; url?: string };
}): Promise<{ lead: Lead; created: boolean }> {
  const { personId, source } = parseInput(createLeadInput, input);
  const entry = sourceEntry(source);
  const row = await tenantClient.lead.findFirst({ where: { personId } });
  if (row !== null) {
    const stored = asLead(row);
    const sources = mergeSource(stored.sources, entry);
    if (sources === stored.sources) return { lead: stored, created: false };
    const lead = await tenantClient.lead.update({ where: { personId }, data: { sources } });
    return { lead: asLead(lead), created: false };
  }
  await getPerson(personId);
  const { workspaceId } = currentTenant();
  const lead = await tenantClient.lead.create({
    data: {
      personId,
      workspaceId,
      sourceLabel: entry.kind,
      sources: [entry],
      firstSourceAt: new Date(entry.at),
    },
  });
  return { lead: asLead(lead), created: true };
}

/**
 * What qualification decided, in one update that replaces the previous decision: a value not given
 * is emptied, so no score or tier outlives the status it came with. The reason goes to
 * `hardFilterReason` for `hard_filtered`, to `statusReason` otherwise. lead_not_found.
 */
export async function applyQualification(input: {
  personId: string;
  status: QualificationStatus;
  fitScore?: number;
  confidence?: Confidence;
  tier?: Tier;
  why?: readonly WhyBullet[];
  snapshotId?: string;
  icpVersion?: number;
  reason?: string;
}): Promise<Lead> {
  const { personId, status, reason, ...result } = parseInput(applyQualificationInput, input);
  const stored = await tenantClient.lead.findFirst({
    where: { personId },
    select: { personId: true },
  });
  if (stored === null) throw new AppError(errors.lead_not_found);
  const filtered = status === "hard_filtered";
  const lead = await tenantClient.lead.update({
    where: { personId },
    data: {
      qualificationStatus: status,
      fitScore: result.fitScore ?? null,
      fitConfidence: result.confidence ?? null,
      tier: result.tier ?? null,
      why: result.why ?? [],
      currentScoreSnapshotId: result.snapshotId ?? null,
      icpVersionScored: result.icpVersion ?? null,
      hardFilterReason: filtered ? (reason ?? null) : null,
      statusReason: filtered ? null : (reason ?? null),
    },
  });
  return asLead(lead);
}

/**
 * A page of the workspace's leads with their persons, by descending fit (no score last), newest
 * first, or unreviewed first (the leads without a decision, then Good lead, then Not a fit, each by
 * descending fit), ties by the person id; `status`, `tier`, `review` (`unreviewed`: no decision
 * yet) and `outreach` filter. `cursor` is the `nextCursor` of the page before, in the same sort,
 * else contacts_input_invalid naming `cursor`; null on the last page.
 */
export async function listLeads(input: {
  status?: QualificationStatus;
  tier?: Tier;
  review?: ReviewFilter;
  outreach?: OutreachStatus;
  sort: LeadSort;
  limit: number;
  cursor?: string;
}): Promise<{ leads: LeadWithPerson[]; nextCursor: string | null }> {
  const { sort, limit, cursor, ...view } = parseInput(leadListInput, input);
  const after = cursor === undefined ? undefined : decodeCursor(sort, cursor);
  if (after === null) {
    throw new AppError(errors.contacts_input_invalid, { details: { fields: ["cursor"] } });
  }
  const rows = await tenantClient.lead.findMany({
    where: { AND: [filters(view), after ? afterCursor(after) : {}] },
    orderBy: order(sort),
    take: limit + 1,
  });
  const page = rows.slice(0, limit).map(asLead);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? encodeCursor(sort, last) : null;
  return { leads: await withPersons(page), nextCursor };
}

/**
 * The leads just before and just after the person's in the list's view (`sort`, filtered by
 * `status`, `tier`, `review` and `outreach`, as listLeads reads them): their person ids, null at
 * either end.
 * The person's lead keeps its place in the sort even when the filters would leave it out.
 * lead_not_found.
 */
export async function leadNeighbours(input: {
  personId: string;
  status?: QualificationStatus;
  tier?: Tier;
  review?: ReviewFilter;
  outreach?: OutreachStatus;
  sort: LeadSort;
}): Promise<{ previous: string | null; next: string | null }> {
  const { personId, sort, ...view } = parseInput(neighboursInput, input);
  const select = { personId: true, fitScore: true, createdAt: true, reviewStatus: true } as const;
  const lead = await tenantClient.lead.findFirst({ where: { personId }, select });
  if (lead === null) throw new AppError(errors.lead_not_found);
  const at = positionOf(sort, lead);
  const where = filters(view);
  const ids = { personId: true } as const;
  const next = await tenantClient.lead.findFirst({
    where: { AND: [where, afterCursor(at)] },
    orderBy: order(sort),
    select: ids,
  });
  const previous = await tenantClient.lead.findFirst({
    where: { AND: [where, beforeCursor(at)] },
    orderBy: order(sort, "reversed"),
    select: ids,
  });
  return { previous: previous?.personId ?? null, next: next?.personId ?? null };
}

/** How many of the workspace's leads are in each status, every status named: one grouped query. */
export async function countLeads(): Promise<Record<QualificationStatus, number>> {
  const groups = await tenantClient.lead.groupBy({
    by: ["qualificationStatus"],
    _count: { _all: true },
  });
  const counts = Object.fromEntries(QUALIFICATION_STATUSES.map((status) => [status, 0]));
  for (const group of groups) counts[group.qualificationStatus] = group._count._all;
  return counts as Record<QualificationStatus, number>;
}

/** The person's lead with the person; lead_not_found, also for another workspace's person. */
export async function getLead(personId: string): Promise<LeadWithPerson> {
  const id = requireId("personId", personId);
  const lead = await tenantClient.lead.findFirst({ where: { personId: id } });
  if (lead === null) throw new AppError(errors.lead_not_found);
  return { ...asLead(lead), person: await getPerson(id) };
}

/**
 * Up to `limit` leads waiting for qualification, oldest first: what the batch workflow reads. With
 * `icpVersion`, the ICP's current version, a lead decided at an older version waits too.
 */
export async function leadsPendingQualification(input: {
  limit: number;
  icpVersion?: number;
}): Promise<Lead[]> {
  const { limit, icpVersion } = parseInput(pendingInput, input);
  const pending = { qualificationStatus: "pending" } as const;
  const older = { icpVersionScored: { lt: icpVersion } };
  const rows = await tenantClient.lead.findMany({
    where: icpVersion === undefined ? pending : { OR: [pending, older] },
    orderBy: [{ createdAt: "asc" }, { personId: "asc" }],
    take: limit,
  });
  return rows.map(asLead);
}

/** A row as a Lead: its JSON columns hold what createLeadForPerson and applyQualification write. */
function asLead(row: unknown): Lead {
  return row as Lead;
}

/** The list's filters: `unreviewed` is the leads without a decision. */
function filters(view: {
  status?: QualificationStatus;
  tier?: Tier;
  review?: ReviewFilter;
  outreach?: OutreachStatus;
}) {
  const reviewStatus = view.review === "unreviewed" ? null : undefined;
  return {
    qualificationStatus: view.status,
    tier: view.tier,
    reviewStatus,
    outreachStatus: view.outreach,
  };
}

/**
 * The list's order, by descending fit (no score last), newest first, or unreviewed first (no
 * decision, then the decisions in their order, each by fit), ties by the person id; or its
 * reverse, for the lead before a position.
 */
function order(sort: LeadSort, reversed?: "reversed") {
  const direction = reversed ? ("asc" as const) : ("desc" as const);
  if (sort === "newest") return [{ createdAt: direction }, { personId: direction }];
  const nulls = reversed ? ("first" as const) : ("last" as const);
  const byFit = [{ fitScore: { sort: direction, nulls } }, { personId: direction }];
  if (sort === "fit") return byFit;
  // No decision first, then the decisions in their enum's order (good_lead, not_a_fit).
  const unreviewed = reversed ? ("last" as const) : ("first" as const);
  const decisions = reversed ? ("desc" as const) : ("asc" as const);
  return [{ reviewStatus: { sort: decisions, nulls: unreviewed } }, ...byFit];
}

/** The leads after the cursor's position in its sort, ties broken by the person id. */
function afterCursor(after: LeadCursor) {
  const tie = { personId: { lt: after.personId } };
  if (after.sort === "newest") {
    return { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, ...tie }] };
  }
  const { fitScore } = after;
  const byFit =
    fitScore === null
      ? { fitScore: null, ...tie }
      : { OR: [{ fitScore: { lt: fitScore } }, { fitScore, ...tie }, { fitScore: null }] };
  if (after.sort === "fit") return byFit;
  const status = after.reviewStatus;
  const later = REVIEW_DECISIONS.slice(status === null ? 0 : REVIEW_DECISIONS.indexOf(status) + 1);
  return { OR: [{ AND: [{ reviewStatus: status }, byFit] }, { reviewStatus: { in: later } }] };
}

/** The leads before the position in its sort: afterCursor's mirror. */
function beforeCursor(at: LeadCursor) {
  const tie = { personId: { gt: at.personId } };
  if (at.sort === "newest") {
    return { OR: [{ createdAt: { gt: at.createdAt } }, { createdAt: at.createdAt, ...tie }] };
  }
  const { fitScore } = at;
  const byFit =
    fitScore === null
      ? { OR: [{ fitScore: { not: null } }, { fitScore: null, ...tie }] }
      : { OR: [{ fitScore: { gt: fitScore } }, { fitScore, ...tie }] };
  if (at.sort === "fit") return byFit;
  const status = at.reviewStatus;
  if (status === null) return { AND: [{ reviewStatus: null }, byFit] };
  const earlier = REVIEW_DECISIONS.slice(0, REVIEW_DECISIONS.indexOf(status));
  return {
    OR: [
      { AND: [{ reviewStatus: status }, byFit] },
      { reviewStatus: null },
      { reviewStatus: { in: earlier } },
    ],
  };
}

/** The leads with their persons, read in one query; a lead's person is always there (the key). */
async function withPersons(leads: readonly Lead[]): Promise<LeadWithPerson[]> {
  if (leads.length === 0) return [];
  const ids = leads.map((lead) => lead.personId);
  const persons = (await tenantClient.person.findMany({ where: { id: { in: ids } } })) as Person[];
  const byId = new Map(persons.map((person) => [person.id, person]));
  return leads.flatMap((lead) => {
    const person = byId.get(lead.personId);
    return person === undefined ? [] : [{ ...lead, person }];
  });
}
