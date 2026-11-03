// The draft of the ICP (README "The draft"): the script's request, which marks the ICP drafting under
// a new run and publishes icp.draft_requested in the same transaction, and the drafter's reads and
// write, which act only while the run is still the ICP's latest. Each runs in the caller's tenant run,
// through tenantClient. The draft's columns never move the version and never publish icp.updated.

import { outboxWriter, Prisma, tenantClient } from "@whytide/db";
import { type CompanyKnowledge, readCompanyKnowledge } from "@whytide/onboarding";
import { AppError, currentTenant, newId, publish, tenantErrors } from "@whytide/platform";
import { draftErrors } from "../errors.ts";
import { events } from "../events.ts";
import { ids } from "../ids.ts";
import {
  type DraftProfileInput,
  type PendingDraft,
  pendingDraft,
} from "../schemas/draft-profile.ts";
import { lockedIcpId } from "./commands.ts";
import { type DraftStatus, LIMITS } from "./lists.ts";

/** What a draft's workflow carries: the ICP and the run the request started. Ids only. */
export type DraftRun = {
  readonly workspaceId: string;
  readonly icpId: string;
  readonly draftRunId: string;
};
/** What the drafter ended with: the draft, or the machine code it failed with. */
export type DraftOutcome =
  | { readonly ok: true; readonly draft: PendingDraft }
  | { readonly ok: false; readonly code: string };
/** What a draft's run ended with, kept in Temporal's history: a status and a code, never a value. */
export type DraftResult = {
  readonly status: "drafted" | "failed" | "superseded";
  readonly code?: string;
};
/** The ICP's latest draft, as the script reads it while the worker drafts. */
export type IcpDraft = {
  readonly status: DraftStatus;
  readonly error: string | null;
  readonly draftRunId: string | null;
  readonly pending: PendingDraft | null;
};

/**
 * Requests a draft: the ICP, created on the first read, becomes `drafting` under a new run with the
 * brief, trimmed, its error and pending draft cleared, and icp.draft_requested carries the ids to the
 * worker, in the same transaction; the run's id is the answer. A brief over LIMITS.brief is
 * icp_draft_brief_too_long; no content field and no brief is icp_draft_no_source; neither writes.
 */
export async function requestDraft(workspaceId: string, given: string): Promise<string> {
  if (currentTenant().workspaceId !== workspaceId) throw new AppError(tenantErrors.tenant_mismatch);
  const brief = given.trim();
  if (brief.length > LIMITS.brief) {
    throw new AppError(draftErrors.icp_draft_brief_too_long, { details: { max: LIMITS.brief } });
  }
  const knowledge = await readCompanyKnowledge(workspaceId);
  if (sourcesOf(knowledge, brief) === null) throw new AppError(draftErrors.icp_draft_no_source);
  const id = await lockedIcpId();
  const draftRunId = newId(ids.icp_draft_run);
  await tenantClient.icp.update({
    where: { id },
    data: {
      ...{ draftStatus: "drafting", draftError: null, draftRunId },
      ...{ draftBrief: brief, pendingDraft: Prisma.DbNull },
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
 * The sources of `run`, read while it is the ICP's latest draft: `input` null when nothing is left
 * to draft from; null once a later request started a new run.
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
 * Writes what the drafter of `run` ended with while `run` is the ICP's latest draft, the row locked:
 * the pending draft and `drafted`, or `failed` with the code. Only the script's save writes a field.
 */
export async function recordDraft(run: DraftRun, outcome: DraftOutcome): Promise<DraftResult> {
  if (!(await isLatest(run))) return { status: "superseded" };
  const data = outcome.ok
    ? { draftStatus: "drafted", draftError: null, pendingDraft: outcome.draft }
    : { draftStatus: "failed", draftError: outcome.code, pendingDraft: Prisma.DbNull };
  await tenantClient.icp.update({ where: { id: run.icpId }, data });
  return outcome.ok ? { status: "drafted" } : { status: "failed", code: outcome.code };
}

/** The run's ICP's latest draft; the request made the ICP, so it exists. */
export async function readDraft(): Promise<IcpDraft> {
  const row = await tenantClient.icp.findFirstOrThrow({
    select: { draftStatus: true, draftError: true, draftRunId: true, pendingDraft: true },
  });
  return {
    status: row.draftStatus as DraftStatus,
    error: row.draftError,
    draftRunId: row.draftRunId,
    pending: row.pendingDraft === null ? null : pendingDraft.parse(row.pendingDraft),
  };
}

/** Locks the ICP's row until the run commits; true while `run` is still its latest draft. */
async function isLatest(run: DraftRun): Promise<boolean> {
  const id = await lockedIcpId();
  const { draftRunId } = await tenantClient.icp.findFirstOrThrow({
    where: { id },
    select: { draftRunId: true },
  });
  return id === run.icpId && draftRunId === run.draftRunId;
}
