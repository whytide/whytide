// The re-score (README "The re-score", docs/flows.md): a criteria save moves no ICP version
// (decisions.md, 2026-10-22), so a scored lead is scored again from its stored verdicts with the
// current criteria of its snapshot's audience (gamma-p5-050). A copy of its snapshot, keyed with
// the criteria's hash, is scored and takes the lead, and its decision is published; the scored
// snapshot stays as it is (only a member's verdict decides one again). No model call and no
// credits. requestRescore writes the request; the worker's qualification_rescore runs rescorePage,
// by page. Every person of a page gets the intent of now, a lead the criteria do not move too, so
// that a new or newly rated signal counts at once (README "Intent and priority"). The snapshot that
// takes the lead carries the members' verdicts of the criteria the ICP still has (README "A
// member's verdict").
import { getLead, listLeads } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { listAudiences, readIcpForScoring } from "@whytide/icp";
import { AppError, currentTenant, isAppError, newId, publish } from "@whytide/platform";
import { errors } from "../errors.ts";
import { events } from "../events.ts";
import { ids } from "../ids.ts";
import type { Criterion } from "../schemas/assess-fit.ts";
import { type RescoreBody, rescoreBody } from "../schemas/rescore.ts";
import { publishDecision } from "./decision.ts";
import { criteriaHash } from "./score/criteria-hash.ts";
import { carryMemberParts } from "./score/member.ts";
import {
  reapplySnapshot,
  redecideSnapshot,
  scoreSnapshot,
  updateIntent,
} from "./score/score-snapshot.ts";

/** The leads one activity re-scores in one run. */
export const RESCORE_PAGE = 50;
/**
 * An audience's version, its criteria's hash, what a lead's snapshot is compared with, and their
 * keys.
 */
type Scoring = {
  readonly icpVersion: number;
  readonly hash: string;
  readonly keys: ReadonlySet<Criterion>;
};
/** Each audience's Scoring by a snapshot's audience, read once per call: null is the default. */
type Scorings = (icpId: string | null) => Promise<Scoring>;
/** What a snapshot is compared with: its audience, version, status and the criteria scoring it. */
type SnapshotScoring = {
  readonly icpId: string | null;
  readonly icpVersion: number;
  readonly status: string;
  readonly scoredCriteriaHash: string;
};

/**
 * Asks the worker to re-score the workspace's scored leads, or the named persons', in the caller's
 * tenant run: qualification.rescore_requested, which starts qualification_rescore. The request's
 * id, and how many leads it marked: those the run moves with the current criteria, by rescoreLead's
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
 * after `after` with an assessment against an audience at its current version, each with the intent
 * at `at` (a skipped one through updateIntent, with no event). The counts, and where the next
 * starts.
 */
export async function rescorePage(
  input: { personIds?: readonly string[]; after?: string },
  at = new Date(),
) {
  const now = scorings();
  let next: string | null = null;
  let personIds = input.personIds;
  if (personIds === undefined) {
    const after = input.after === undefined ? {} : { personId: { gt: input.after } };
    // The default's snapshots include those of the previous release, which name no audience.
    const current = (await listAudiences()).flatMap(({ id, isDefault, version }) => [
      { icpId: id, icpVersion: version },
      ...(isDefault ? [{ icpId: null, icpVersion: version }] : []),
    ]);
    const rows = await tenantClient.scoreSnapshot.findMany({
      where: { OR: current, criteriaHash: "", ...after },
      select: { personId: true },
      orderBy: { personId: "asc" },
      take: RESCORE_PAGE,
    });
    personIds = rows.map((row) => row.personId);
    if (rows.length === RESCORE_PAGE) next = personIds[RESCORE_PAGE - 1] ?? null;
  }
  const persons = [...new Set(personIds)];
  let rescored = 0;
  for (const personId of persons) {
    if (await rescoreLead(personId, now, at)) rescored += 1;
    else await updateIntent(personId, at);
  }
  return { rescored, skipped: persons.length - rescored, next };
}

/** The Scoring of a snapshot's audience, each audience read once by the function returned. */
function scorings(): Scorings {
  const read = new Map<string, Promise<Scoring>>();
  return (icpId) => {
    const key = icpId ?? "";
    const known = read.get(key);
    if (known !== undefined) return known;
    const scoring = readIcpForScoring(currentTenant().workspaceId, icpId ?? undefined).then(
      ({ icp, criteria }) => {
        const keys = new Set(criteria.map(({ key }) => key));
        return { icpVersion: icp.version, hash: criteriaHash(criteria), keys };
      },
    );
    read.set(key, scoring);
    return scoring;
  };
}

/**
 * The person's lead re-scored now, in the caller's tenant run, when other criteria than its
 * audience's current ones scored its snapshot at that audience's version, as the re-score would: a
 * member's edit then decides with the criteria the snapshot was scored by. False when skipped.
 */
export async function rescoreMoved(personId: string, at = new Date()): Promise<boolean> {
  return rescoreLead(personId, scorings(), at);
}

/**
 * Whether a re-score moves a lead from the snapshot: scored at its audience's current version by
 * other criteria than that audience's.
 */
async function moves(snapshot: SnapshotScoring, now: Scorings): Promise<boolean> {
  const { icpVersion, hash } = await now(snapshot.icpId);
  const { status, scoredCriteriaHash } = snapshot;
  return snapshot.icpVersion === icpVersion && status !== "assessed" && scoredCriteriaHash !== hash;
}

/**
 * The person's current snapshot when a re-score moves the lead, with its audience's Scoring; null,
 * skipped, when the person has no lead or no scored snapshot at its audience's version (the batch
 * assesses it), or these criteria scored it. A lead that waits is the batch's too, whatever
 * snapshot it keeps (README "A new assessment").
 */
async function movable(personId: string, now: Scorings) {
  const lead = await getLead(personId).catch((error: unknown) => {
    if (isAppError(error) && error.code === "lead_not_found") return null;
    throw error;
  });
  if (lead === null || lead.qualificationStatus === "pending") return null;
  const id = lead.currentScoreSnapshotId;
  if (id === null) return null;
  const snapshot = await tenantClient.scoreSnapshot.findFirst({ where: { id } });
  if (snapshot === null || !(await moves(snapshot, now))) return null;
  return { snapshot, scoring: await now(snapshot.icpId) };
}

/** The leads a re-score moves now: the named persons', or every lead's, by pages of contacts' list. */
async function countMarked(personIds: readonly string[] | undefined): Promise<number> {
  const now = scorings();
  let marked = 0;
  if (personIds !== undefined) {
    for (const personId of new Set(personIds)) if (await movable(personId, now)) marked += 1;
    return marked;
  }
  let cursor: string | undefined;
  do {
    const page = await listLeads({ sort: "newest", limit: 100, cursor });
    const current = page.leads.flatMap((lead) =>
      lead.qualificationStatus === "pending" ? [] : (lead.currentScoreSnapshotId ?? []),
    );
    const select = { icpId: true, icpVersion: true, status: true, scoredCriteriaHash: true };
    const where = { id: { in: current }, status: { not: "assessed" as const } };
    for (const snapshot of await tenantClient.scoreSnapshot.findMany({ where, select })) {
      if (await moves(snapshot, now)) marked += 1;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return marked;
}

/**
 * The lead scored from its current snapshot's verdicts with its audience's current criteria: a new
 * copy scored, or the snapshot these criteria scored before, the assessment's own or a copy, given
 * back. False, skipped, as movable says.
 */
async function rescoreLead(personId: string, now: Scorings, at: Date): Promise<boolean> {
  const moved = await movable(personId, now);
  if (moved === null) return false;
  const { snapshot: current, scoring } = moved;
  const { workspaceId, decisionRecordId, icpId, icpVersion, modelId, promptVersion } = current;
  const before = { decisionRecordId, icpId, icpVersion, scoredCriteriaHash: scoring.hash };
  const scored = await tenantClient.scoreSnapshot.findFirst({
    where: before,
    select: { id: true },
  });
  const verdicts = await tenantClient.criterionVerdict.findMany({
    where: { snapshotId: current.id },
  });
  if (scored !== null) {
    // Given back with the members' verdicts of now: decided again when they changed.
    const changed = await carryMemberParts(verdicts, scored.id, scoring.keys);
    await (changed ? redecideSnapshot : reapplySnapshot)(scored.id, at);
    await publishDecision(personId);
    return true;
  }
  const id = newId(ids.score_snapshot);
  const { summary, disqualifiers } = current;
  const row = { id, workspaceId, personId, icpId, icpVersion, modelId, promptVersion, summary };
  const key = { decisionRecordId, criteriaHash: scoring.hash };
  await tenantClient.scoreSnapshot.create({ data: { ...row, ...key, disqualifiers } });
  // The model's verdicts, then the members' over them.
  const rows = verdicts.flatMap(({ criterion, verdict, evidence }) =>
    verdict === null
      ? []
      : [{ criterion, verdict, evidence, id: newId(ids.criterion_verdict), workspaceId }],
  );
  await tenantClient.criterionVerdict.createMany({
    data: rows.map((v) => ({ ...v, snapshotId: id })),
  });
  await carryMemberParts(verdicts, id, scoring.keys);
  await scoreSnapshot(id, at);
  await publishDecision(personId);
  return true;
}
