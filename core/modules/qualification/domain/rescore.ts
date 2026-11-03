// The re-score (README "The re-score", docs/flows.md): a criteria save moves no ICP version
// (decisions.md, 2026-10-22), so a scored lead is scored again from its stored verdicts with the
// current criteria. A copy of its snapshot, keyed with the criteria's hash, is scored and takes the
// lead, and its decision is published; the scored snapshot stays final. No model call and no credits.
// requestRescore writes the request; the worker's qualification_rescore runs rescorePage, by page.
import { getLead, listLeads } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { readIcpForScoring } from "@whytide/icp";
import { AppError, currentTenant, isAppError, newId, publish } from "@whytide/platform";
import { errors } from "../errors.ts";
import { events } from "../events.ts";
import { ids } from "../ids.ts";
import { type RescoreBody, rescoreBody } from "../schemas/rescore.ts";
import { publishDecision } from "./decision.ts";
import { criteriaHash } from "./score/criteria-hash.ts";
import { reapplySnapshot, scoreSnapshot } from "./score/score-snapshot.ts";

/** The leads one activity re-scores in one run. */
export const RESCORE_PAGE = 50;
/** The ICP's version and its criteria's hash, what a lead's snapshot is compared with. */
type Scoring = { readonly icpVersion: number; readonly hash: string };

/**
 * Asks the worker to re-score the workspace's scored leads, or the named persons', in the caller's
 * tenant run: qualification.rescore_requested, which starts qualification_rescore. The request's id,
 * and how many leads it marked: those the run moves with the current criteria, by rescoreLead's
 * rule. qualification_input_invalid.
 */
export async function requestRescore(
  input: RescoreBody,
): Promise<{ requestId: string; marked: number }> {
  const parsed = rescoreBody.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new AppError(errors.qualification_input_invalid, { details: { fields } });
  }
  const { workspaceId } = currentTenant();
  const marked = await countMarked(parsed.data.personIds);
  const requestId = newId(ids.rescore_request);
  const payload = { workspaceId, requestId, personIds: parsed.data.personIds ?? null };
  const outbox = outboxWriter(tenantClient, workspaceId);
  await publish(outbox, events["qualification.rescore_requested"], payload);
  return { requestId, marked };
}

/**
 * One page in the caller's tenant run: the named persons, or the next RESCORE_PAGE persons by id
 * after `after` with an assessment at the current ICP version. The counts, and where the next starts.
 */
export async function rescorePage(input: { personIds?: readonly string[]; after?: string }) {
  const now = await scoring();
  let next: string | null = null;
  let personIds = input.personIds;
  if (personIds === undefined) {
    const after = input.after === undefined ? {} : { personId: { gt: input.after } };
    const rows = await tenantClient.scoreSnapshot.findMany({
      where: { icpVersion: now.icpVersion, criteriaHash: "", ...after },
      select: { personId: true },
      orderBy: { personId: "asc" },
      take: RESCORE_PAGE,
    });
    personIds = rows.map((row) => row.personId);
    if (rows.length === RESCORE_PAGE) next = personIds[RESCORE_PAGE - 1] ?? null;
  }
  const persons = [...new Set(personIds)];
  let rescored = 0;
  for (const personId of persons) if (await rescoreLead(personId, now)) rescored += 1;
  return { rescored, skipped: persons.length - rescored, next };
}

async function scoring(): Promise<Scoring> {
  const { icp, criteria } = await readIcpForScoring(currentTenant().workspaceId);
  return { icpVersion: icp.version, hash: criteriaHash(criteria) };
}

/** The snapshots a re-score moves a lead from: scored at this ICP version by other criteria. */
const movedBy = ({ icpVersion, hash }: Scoring) => ({
  icpVersion,
  status: { not: "assessed" as const },
  scoredCriteriaHash: { not: hash },
});

/**
 * The person's current snapshot when a re-score moves the lead; null, skipped, when the person has no
 * lead or no scored snapshot at this ICP version (the batch assesses it), or these criteria scored it.
 */
async function movable(personId: string, now: Scoring) {
  const lead = await getLead(personId).catch((error: unknown) => {
    if (isAppError(error) && error.code === "lead_not_found") return null;
    throw error;
  });
  const id = lead?.currentScoreSnapshotId ?? null;
  if (id === null) return null;
  return tenantClient.scoreSnapshot.findFirst({ where: { id, ...movedBy(now) } });
}

/** The leads a re-score moves now: the named persons', or every lead's, by pages of contacts' list. */
async function countMarked(personIds: readonly string[] | undefined): Promise<number> {
  const now = await scoring();
  let marked = 0;
  if (personIds !== undefined) {
    for (const personId of new Set(personIds)) if (await movable(personId, now)) marked += 1;
    return marked;
  }
  let cursor: string | undefined;
  do {
    const page = await listLeads({ sort: "newest", limit: 100, cursor });
    const current = page.leads.flatMap((lead) => lead.currentScoreSnapshotId ?? []);
    const where = { id: { in: current }, ...movedBy(now) };
    marked += await tenantClient.scoreSnapshot.count({ where });
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return marked;
}

/**
 * The lead scored from its current snapshot's verdicts with the current criteria: a new copy scored,
 * or the snapshot these criteria scored before, the assessment's own or a copy, given back. False,
 * skipped, as movable says.
 */
async function rescoreLead(personId: string, now: Scoring): Promise<boolean> {
  const current = await movable(personId, now);
  if (current === null) return false;
  const { workspaceId, decisionRecordId, icpVersion, modelId, promptVersion } = current;
  const before = { decisionRecordId, icpVersion, scoredCriteriaHash: now.hash };
  const scored = await tenantClient.scoreSnapshot.findFirst({
    where: before,
    select: { id: true },
  });
  if (scored !== null) {
    await reapplySnapshot(scored.id);
    await publishDecision(personId);
    return true;
  }
  const id = newId(ids.score_snapshot);
  const { summary, disqualifiers } = current;
  const row = { id, workspaceId, personId, icpVersion, modelId, promptVersion, summary };
  const key = { decisionRecordId, criteriaHash: now.hash };
  await tenantClient.scoreSnapshot.create({ data: { ...row, ...key, disqualifiers } });
  const verdicts = await tenantClient.criterionVerdict.findMany({
    where: { snapshotId: current.id },
    select: { criterion: true, verdict: true, evidence: true },
  });
  const rows = verdicts.map((v) => ({ ...v, id: newId(ids.criterion_verdict), workspaceId }));
  await tenantClient.criterionVerdict.createMany({
    data: rows.map((v) => ({ ...v, snapshotId: id })),
  });
  await scoreSnapshot(id);
  await publishDecision(personId);
  return true;
}
