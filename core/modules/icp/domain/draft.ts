// The draft of an audience (README "The draft"): the request of the screen and of the script, which
// marks the audience drafting under a new run and publishes icp.draft_requested in the same
// transaction; the drafter's reads and write, which act only while the run is still the audience's
// latest; and the review, which saves the drafted proposal through saveIcp or discards it. The
// automatic draft's run (./auto-draft.ts) saves its own proposal, as the review would, while the
// default is still empty. Each runs in the caller's tenant run, through tenantClient, on the audience
// `icpId`, or on the default without one. The draft's columns never move the version and never
// publish an event of a change; only a save does, as a screen save does.

import { outboxWriter, Prisma, tenantClient } from "@whytide/db";
import { type CompanyKnowledge, readCompanyKnowledge } from "@whytide/onboarding";
import { AppError, currentTenant, newId, publish, tenantErrors } from "@whytide/platform";
import { draftErrors, errors } from "../errors.ts";
import { events } from "../events.ts";
import { ids } from "../ids.ts";
import {
  type DraftProfileInput,
  type PendingDraft,
  pendingDraft,
} from "../schemas/draft-profile.ts";
import { icpBody } from "../schemas/icp.ts";
import { getIcp, type Icp, lockedIcpId, saveIcp } from "./commands.ts";
import { type DraftStatus, LIMITS } from "./lists.ts";
import { hasTargeting, type IcpFields } from "./rules.ts";

/** What a draft's workflow carries: the audience and the run the request started. Ids only. */
export type DraftRun = {
  readonly workspaceId: string;
  readonly icpId: string;
  readonly draftRunId: string;
};
/** What the drafter ended with: the draft, or the machine code it failed with. */
export type DraftOutcome =
  | { readonly ok: true; readonly draft: PendingDraft }
  | { readonly ok: false; readonly code: string };
/**
 * What a draft's run ended with, kept in Temporal's history: a status and a code, never a value;
 * `saved` an automatic run's proposal saved into the empty default.
 */
export type DraftResult = {
  readonly status: "drafted" | "saved" | "failed" | "superseded";
  readonly code?: string;
};
/** The audience's latest draft, as the script reads it while the worker drafts. */
export type IcpDraft = {
  readonly status: DraftStatus;
  readonly error: string | null;
  readonly draftRunId: string | null;
  readonly pending: PendingDraft | null;
};
/** The audience's latest draft as the screen reads it, and whether Company Knowledge has a field. */
export type DraftView = IcpDraft & { readonly hasKnowledge: boolean };

/** What the review leaves: no draft, and no run that may still write one. The brief stays. */
const DRAFT_ENDED = {
  draftStatus: "none",
  draftError: null,
  draftRunId: null,
  draftAutomatic: false,
  pendingDraft: Prisma.DbNull,
};

/**
 * Requests a draft: the audience `icpId`, or the default, created on the first read, becomes
 * `drafting` under a new run with the brief, trimmed, its error and pending draft cleared, and
 * icp.draft_requested carries the ids to the worker, in the same transaction; the run's id is the
 * answer. A brief over LIMITS.brief is icp_draft_brief_too_long; no content field and no brief is
 * icp_draft_no_source; neither writes.
 */
export async function requestDraft(
  workspaceId: string,
  given: string,
  icpId?: string,
): Promise<string> {
  if (currentTenant().workspaceId !== workspaceId) throw new AppError(tenantErrors.tenant_mismatch);
  const brief = given.trim();
  if (brief.length > LIMITS.brief) {
    throw new AppError(draftErrors.icp_draft_brief_too_long, { details: { max: LIMITS.brief } });
  }
  const knowledge = await readCompanyKnowledge(workspaceId);
  if (sourcesOf(knowledge, brief) === null) throw new AppError(draftErrors.icp_draft_no_source);
  return startDraft(await lockedIcpId(icpId), brief, false);
}

/**
 * Marks the locked audience `id` drafting under a new run with `brief`, a member's run or the
 * automatic one, its error and pending draft cleared, and publishes icp.draft_requested in the same
 * transaction; the run's id is the answer.
 */
export async function startDraft(id: string, brief: string, automatic: boolean): Promise<string> {
  const { workspaceId } = currentTenant();
  const draftRunId = newId(ids.icp_draft_run);
  await tenantClient.icp.update({
    where: { id },
    data: {
      ...{ draftStatus: "drafting", draftError: null, draftRunId },
      ...{ draftBrief: brief, draftAutomatic: automatic, pendingDraft: Prisma.DbNull },
    },
  });
  const outbox = outboxWriter(tenantClient, workspaceId);
  await publish(outbox, events["icp.draft_requested"], { workspaceId, icpId: id, draftRunId });
  return draftRunId;
}

/**
 * What the drafter reads: Company Knowledge's content fields as accepted, never its pending draft,
 * the proof points' texts without their pages, and the brief; null when every one is empty.
 */
export function sourcesOf(knowledge: CompanyKnowledge, brief: string): DraftProfileInput | null {
  const company = {
    oneLiner: knowledge.oneLiner,
    longDescription: knowledge.longDescription,
    products: knowledge.products,
    painPoints: knowledge.painPoints,
    featuresBenefits: knowledge.featuresBenefits,
    proofPoints: knowledge.proofPoints.map((point) => point.text),
    competitors: knowledge.competitors,
  };
  const empty = Object.values(company).every((value) => value.length === 0) && brief === "";
  return empty ? null : { company, brief };
}

/**
 * The sources of `run`, read while it is its audience's latest draft: `input` null when nothing is
 * left to draft from; null once a later request started a new run.
 */
export async function draftSources(
  run: DraftRun,
): Promise<{ readonly input: DraftProfileInput | null } | null> {
  const row = await tenantClient.icp.findFirst({
    where: { id: run.icpId },
    select: { draftRunId: true, draftBrief: true },
  });
  if (row?.draftRunId !== run.draftRunId) return null;
  return { input: sourcesOf(await readCompanyKnowledge(run.workspaceId), row.draftBrief) };
}

/**
 * Writes what the drafter of `run` ended with while `run` is its audience's latest draft, the row
 * locked: the pending draft and `drafted`, or `failed` with the code. An automatic run's proposal is
 * `saved` instead while its audience has no targeting (savedItself); else only the review's save
 * writes a field.
 */
export async function recordDraft(run: DraftRun, outcome: DraftOutcome): Promise<DraftResult> {
  if (!(await isLatest(run))) return { status: "superseded" };
  if (outcome.ok && (await savedItself(run, outcome.draft))) return { status: "saved" };
  const data = outcome.ok
    ? { draftStatus: "drafted", draftError: null, pendingDraft: outcome.draft }
    : { draftStatus: "failed", draftError: outcome.code, pendingDraft: Prisma.DbNull };
  await tenantClient.icp.update({ where: { id: run.icpId }, data });
  return outcome.ok ? { status: "drafted" } : { status: "failed", code: outcome.code };
}

/**
 * The latest draft of the audience `icpId`, or of the default, which the request made; an id the
 * workspace does not hold is icp_not_found.
 */
export async function readDraft(icpId?: string): Promise<IcpDraft> {
  const row = await tenantClient.icp.findFirst({
    where: icpId === undefined ? { isDefault: true } : { id: icpId },
    select: { draftStatus: true, draftError: true, draftRunId: true, pendingDraft: true },
  });
  if (row === null) throw new AppError(errors.icp_not_found);
  return {
    status: row.draftStatus as DraftStatus,
    error: row.draftError,
    draftRunId: row.draftRunId,
    pending: row.pendingDraft === null ? null : pendingDraft.parse(row.pendingDraft),
  };
}

/**
 * The latest draft of the audience `icpId`, or of the default, for the screen (README "Routes"), the
 * default created on the first read as getIcp does, and whether Company Knowledge holds a content
 * field: its sources without a brief.
 */
export async function viewDraft(workspaceId: string, icpId?: string): Promise<DraftView> {
  const { id } = await getIcp(workspaceId, icpId);
  const knowledge = await readCompanyKnowledge(workspaceId);
  return { ...(await readDraft(id)), hasKnowledge: sourcesOf(knowledge, "") !== null };
}

/**
 * Saves the proposal of the run `runId` (README "The draft"), the screen's Use this draft and the
 * script's save, on the audience `icpId` or the default, its row locked until the run commits:
 * without a drafted proposal, or with one of another run than `runId`, a later request's,
 * icp_draft_none; over an audience with targeting only with `replace`, else icp_not_empty; the
 * fields as the PUT body takes them, else icp_draft_invalid with their paths. Then saveIcp saves the
 * name and the targeting, the criteria unchanged, and the draft ends, in the same transaction; the
 * answer is the audience as stored.
 */
export async function acceptDraft(replace: boolean, runId: string, icpId?: string): Promise<Icp> {
  const id = await lockedIcpId(icpId);
  const { workspaceId } = currentTenant();
  const { fields } = await draftedOf(id, runId);
  if (!replace && hasTargeting(await getIcp(workspaceId, id))) {
    throw new AppError(draftErrors.icp_not_empty);
  }
  const body = icpBody.safeParse(fields);
  if (!body.success) {
    const paths = body.error.issues.map((issue) => issue.path.join("."));
    throw new AppError(draftErrors.icp_draft_invalid, { details: { fields: paths } });
  }
  await saveProposal(id, body.data);
  return getIcp(workspaceId, id);
}

/**
 * The automatic save (README "The automatic draft"), on the run's locked audience: an automatic
 * run's proposal saved as acceptDraft saves it without `replace` while the audience still has no
 * targeting. A member's run, an audience that got targeting since, or a proposal off the PUT body's
 * schema writes nothing here and is false: the proposal then waits for review.
 */
async function savedItself(run: DraftRun, draft: PendingDraft): Promise<boolean> {
  const { draftAutomatic } = await tenantClient.icp.findFirstOrThrow({
    where: { id: run.icpId },
    select: { draftAutomatic: true },
  });
  if (!draftAutomatic || hasTargeting(await getIcp(run.workspaceId, run.icpId))) return false;
  const body = icpBody.safeParse(draft.fields);
  if (!body.success) return false;
  await saveProposal(run.icpId, body.data);
  return true;
}

/**
 * Saves `fields` on the locked audience `id` through saveIcp, the name and the targeting, the
 * criteria unchanged, and ends the draft, in the caller's transaction.
 */
async function saveProposal(id: string, fields: IcpFields): Promise<void> {
  await saveIcp(fields, id);
  await tenantClient.icp.update({ where: { id }, data: DRAFT_ENDED });
}

/**
 * Discards the drafted proposal of the audience `icpId`, or of the default: the draft ends, every
 * field kept; else icp_draft_none.
 */
export async function discardDraft(icpId?: string): Promise<void> {
  const id = await lockedIcpId(icpId);
  await draftedOf(id);
  await tenantClient.icp.update({ where: { id }, data: DRAFT_ENDED });
}

/**
 * The pending draft of the locked audience `id` once its latest run drafted one, that run `runId`
 * when given; else icp_draft_none.
 */
async function draftedOf(id: string, runId?: string): Promise<PendingDraft> {
  const row = await tenantClient.icp.findFirstOrThrow({
    where: { id },
    select: { draftStatus: true, draftRunId: true, pendingDraft: true },
  });
  const stale = runId !== undefined && row.draftRunId !== runId;
  if (row.draftStatus !== "drafted" || row.pendingDraft === null || stale) {
    throw new AppError(draftErrors.icp_draft_none);
  }
  return pendingDraft.parse(row.pendingDraft);
}

/** Locks the run's audience's row until the run commits; true while `run` is its latest draft. */
async function isLatest(run: DraftRun): Promise<boolean> {
  const id = await lockedIcpId(run.icpId);
  const { draftRunId } = await tenantClient.icp.findFirstOrThrow({
    where: { id },
    select: { draftRunId: true },
  });
  return draftRunId === run.draftRunId;
}
