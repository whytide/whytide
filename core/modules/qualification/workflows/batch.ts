// The batch's activities (README "The batch", docs/flows.md): each is one database step in one
// tenant run, or the model call outside any, so no run is held across a call that leaves the
// process and credits' organization lock lasts one step. Inputs and outputs carry ids, versions and
// codes only: the verdicts and their evidence stay in the snapshot, and the person's excerpts,
// which the assessment reads, never leave its activity (gamma-p5-050). Each lead is assessed
// against its own audience (domain/audience.ts); a step of a batch started before audiences names
// none, the default's, and its reservation keeps the key of before.
import { applyQualification, getCompany, getLead, getPerson } from "@whytide/contacts";
import { type TenantClient, tenantClient, withTenant } from "@whytide/db";
import { readIcpForScoring } from "@whytide/icp";
import {
  type ActivityContext,
  credits,
  isAppError,
  servicePrincipal,
  startWorkflow,
} from "@whytide/platform";
import { listWorkspaceIds } from "@whytide/tenancy";
import { EXCERPTS } from "../domain/anonymize/index.ts";
import { assessmentModel, assessPerson } from "../domain/assess/assess-person.ts";
import { defaultAudienceId, readAudiences, selectLeads } from "../domain/audience.ts";
import { givenClient } from "../domain/client.ts";
import { publishDecision } from "../domain/decision.ts";
import {
  type PreparedHardFilters,
  prepareHardFilters,
  RETIRED_HARD_FILTER_REASONS,
} from "../domain/hard-filters/index.ts";
import { dropIntent, lockPerson } from "../domain/intent/store.ts";
import { cacheAnswered, decideAgain } from "../domain/member-reassess/index.ts";
import { roundSpent } from "../domain/member-reassess/rounds.ts";
import { scoreSnapshot } from "../domain/score/score-snapshot.ts";
import { signalReader } from "../domain/signal-reader.ts";
import { buildWhy } from "../domain/why/index.ts";
import { batchStart } from "../events.ts";
import { prices } from "../prices.ts";
import { settings } from "../settings.ts";

type Context = ActivityContext<TenantClient>;
/** One lead of the batch, its audience and that audience's version; no audience: the default's. */
type Lead = {
  readonly workspaceId: string;
  readonly personId: string;
  readonly icpId?: string;
  readonly icpVersion: number;
};
/** The leads of one audience that passed its filters, oldest first. */
export type AudienceGroup = {
  readonly icpId: string;
  readonly icpVersion: number;
  readonly personIds: string[];
};
/** The lead with its reservation and the attempt it is for; 1 when an older history names none. */
type Held = Lead & { readonly usageId: string; readonly attempt?: number };
const CODE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * One assessment per person, audience, version, model, prompt version and attempt: a repeat
 * reserves nothing more. The first attempt's key has no attempt, as before attempts were counted; a
 * key with no audience is the form of before audiences, which a batch started before them still
 * reserves.
 */
export function assessmentKey(input: {
  personId: string;
  icpId?: string;
  icpVersion: number;
  modelId: string;
  promptVersion: number;
  attempt?: number;
}): string {
  const { personId, icpId, icpVersion, modelId, promptVersion, attempt = 1 } = input;
  const audience = icpId === undefined ? "" : `${icpId}:`;
  const key = `qual:${personId}:${audience}${icpVersion}:${modelId}:${promptVersion}`;
  return attempt === 1 ? key : `${key}:${attempt}`;
}

/**
 * The tick's activity: each workspace with a lead to assess against an audience with targeting gets
 * its batch started, unless one runs; the check is a run of the workspace's own. A workspace that
 * fails leaves the others started, and the tick then fails with its code. The counts only.
 */
export async function startBatches(): Promise<{
  workspaces: number;
  started: number;
  skipped: number;
}> {
  // Tenancy's list: no module reads another's tables (decisions.md, 2026-10-22).
  const workspaceIds = await listWorkspaceIds();
  const counts = { workspaces: workspaceIds.length, started: 0, skipped: 0 };
  const failures: unknown[] = [];
  for (const workspaceId of workspaceIds) {
    try {
      if (!(await hasWork(workspaceId))) counts.skipped += 1;
      else if ((await startWorkflow(batchStart(workspaceId))).started) counts.started += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
  return counts;
}

/**
 * In the workspace's own run: one of its audiences has targeting (an unsaved one has none) and a
 * lead of it waits, pending, decided against it at an older version or by a retired rule: the
 * batch's selection of one lead (domain/audience.ts), which reads one lead at most per audience with
 * targeting. Exported for the tests.
 */
export function hasWork(workspaceId: string): Promise<boolean> {
  const tenant = { workspaceId, principal: servicePrincipal("qualification") };
  const check = async () => {
    const audiences = await readAudiences(workspaceId);
    if (audiences.targeted.size === 0) return false;
    return (await selectLeads(audiences, 1)).length > 0;
  };
  return withTenant(tenant, check, { client: givenClient() });
}

/**
 * The batch's first step, one run: the audiences read once, the leads selected, each with its own
 * audience (domain/audience.ts), and filtered by that audience's filters, prepared once; a lead a
 * retired filter stopped that passes is pending again; a miss is hard_filtered against its audience
 * with the compared values in its why, and its event, under the person's lock, and loses its intent
 * row. The persons who passed, grouped by audience, oldest first. A batch started before audiences
 * asks without `audiences` and gets the answer of before with no lead: the next batch reads them.
 */
export async function filterLeads(
  input: { audiences?: true },
  context: Context,
): Promise<
  | { groups: AudienceGroup[]; filtered: number }
  | { icpVersion: number; personIds: string[]; filtered: number }
> {
  const { workspaceId } = context;
  return context.tenant(async () => {
    if (input.audiences !== true) {
      const { icp } = await readIcpForScoring(workspaceId);
      return { icpVersion: icp.version, personIds: [], filtered: 0 };
    }
    const audiences = await readAudiences(workspaceId);
    const selected = await selectLeads(audiences, settings.QUALIFICATION_BATCH_SIZE);
    const filters = new Map<string, PreparedHardFilters>();
    const groups = new Map<string, AudienceGroup>();
    for (const { lead, icpId, icp } of selected) {
      const { personId } = lead;
      const icpVersion = icp.version;
      const person = await getPerson(personId);
      const company = person.companyId === null ? null : await getCompany(person.companyId);
      const prepared = filters.get(icpId) ?? prepareHardFilters(icp);
      filters.set(icpId, prepared);
      const result = prepared(person, company);
      if (result.passed) {
        if (retiredFilter(lead)) await applyQualification({ personId, status: "pending" });
        const group = groups.get(icpId) ?? { icpId, icpVersion, personIds: [] };
        group.personIds.push(personId);
        groups.set(icpId, group);
        continue;
      }
      const why = buildWhy({ verdicts: [], criteria: [], disqualifiers: [], hardFilter: result });
      const { reason } = result;
      const decision = { status: "hard_filtered", reason, why, icpId, icpVersion } as const;
      await lockPerson(personId);
      await applyQualification({ personId, ...decision });
      await dropIntent(personId);
      await publishDecision(personId);
    }
    const passed = [...groups.values()];
    const count = passed.reduce((sum, { personIds }) => sum + personIds.length, 0);
    return { groups: passed, filtered: selected.length - count };
  });
}

/** A lead hard_filtered for a reason no filter gives anymore (the title, title-check-ai). */
function retiredFilter(lead: { qualificationStatus: string; hardFilterReason: string | null }) {
  const reasons: readonly string[] = RETIRED_HARD_FILTER_REASONS;
  return (
    lead.qualificationStatus === "hard_filtered" && reasons.includes(lead.hardFilterReason ?? "")
  );
}

/**
 * One assessment reserved in a run of its own, under the lead's attempt's key, credits' lock held
 * for that run only. Too few credits: the lead waits, with status_reason insufficient_credits if
 * pending, and the batch stops.
 */
export async function reserveLead(
  input: Lead,
  context: Context,
): Promise<
  { status: "reserved"; usageId: string; attempt: number } | { status: "insufficient_credits" }
> {
  const { personId, icpId, icpVersion } = input;
  const model = await assessmentModel();
  const action = prices["qualification.assessment"];
  const { workspaceId } = context;
  return context.tenant(async () => {
    const where = { personId, icpId: icpId ?? (await defaultAudienceId()), icpVersion };
    const stored = await tenantClient.assessmentAttempt.findFirst({ where });
    const attempt = stored?.attempt ?? 1;
    const idempotencyKey = assessmentKey({ personId, icpId, icpVersion, ...model, attempt });
    const reservation = { workspaceId, action, quantity: 1, idempotencyKey, subjectRef: personId };
    try {
      const { usageId } = await credits.reserve({ ...reservation, lease: "async" });
      return { status: "reserved", usageId, attempt };
    } catch (error) {
      if (!isAppError(error) || error.code !== "insufficient_credits") throw error;
      await waitPending(personId, "insufficient_credits");
      return { status: "insufficient_credits" };
    }
  });
}

/**
 * The model's assessment, outside any run (assessPerson opens its own), against the lead's
 * audience, with up to EXCERPTS of the person's own words from the signal reader, read in a run of
 * their own and handed to assessPerson only: none without a reader, as for an imported person. The
 * snapshot, ai_failed with its reason as a code, or stale when the audience moved since the batch
 * read it.
 */
export async function assessLead(
  input: Lead,
  context: Context,
): Promise<
  | { status: "assessed"; snapshotId: string }
  | { status: "ai_failed"; reason: string }
  | { status: "stale" }
> {
  const { personId, icpId, icpVersion } = input;
  const { workspaceId, tenant } = context;
  const client = givenClient();
  const call = client === undefined ? undefined : { client };
  const reader = signalReader();
  const evidence =
    reader === undefined ? [] : await tenant(() => reader.excerpts({ personId, max: EXCERPTS }));
  try {
    const assess = { personId, icpId, icpVersion, evidence: [...evidence] };
    const result = await assessPerson(assess, { workspaceId, tenant, call });
    if (result.status === "assessed") return { status: "assessed", snapshotId: result.snapshotId };
    const code = result.reason.replaceAll("-", "_");
    return { status: "ai_failed", reason: CODE.test(code) ? code : "ai_failed" };
  } catch (error) {
    if (isAppError(error) && error.code === "icp_version_stale") return { status: "stale" };
    throw error;
  }
}

/**
 * One run: the snapshot scored and the lead given its decision, the reservation committed, the
 * lead's event. A snapshot scored already for a lead that waits, which only the model's answer
 * cache gives back, decides the lead again from it, and the reservation is committed at quantity 0,
 * no credits: no model call was made under it (README "A new assessment"). An ICP that moved since
 * the assessment releases the reservation instead. A reservation past its 24-hour lease rolls the
 * run back: released, the lead's attempt moved, and the workflow reserves again under the next
 * attempt's key.
 */
export async function commitLead(
  input: Held & { snapshotId: string },
  context: Context,
): Promise<{ status: "committed" | "stale" | "lease_expired" }> {
  try {
    return await context.tenant(async () => {
      let cached = false;
      try {
        cached = await cacheAnswered(input.snapshotId);
        if (cached) await decideAgain(input.snapshotId);
        else await scoreSnapshot(input.snapshotId);
      } catch (error) {
        // Thrown before any write: the run goes on.
        if (!isAppError(error) || error.code !== "icp_version_stale") throw error;
        await credits.release(input.usageId);
        return { status: "stale" };
      }
      // Committed, not released, at the cache's answer too: this step run again finds it settled.
      // One committed by a run of this step before a member's press keeps its charge.
      await credits.commit(input.usageId, cached ? 0 : undefined);
      await publishDecision(input.personId);
      return { status: "committed" };
    });
  } catch (error) {
    if (!isAppError(error) || error.code !== "usage_not_open") throw error;
  }
  await releaseLead(input, context);
  return { status: "lease_expired" };
}

/**
 * One run: the reservation released and the lead's attempt moved, so that its key is never reserved
 * again. Given a reason, the lead is ai_failed against the batch's audience and version, under the
 * person's lock, and loses its intent row, unless the provider failed before the last attempt of a
 * round of attempts (README "A new assessment"): then it waits for a later batch, with the reason
 * if pending.
 */
export async function releaseLead(input: Held & { reason?: string }, context: Context) {
  await context.tenant(async () => {
    await credits.release(input.usageId);
    const icpId = input.icpId ?? (await defaultAudienceId());
    const next = await moveAttempt({ ...input, icpId });
    const { personId, icpVersion, reason } = input;
    if (reason === undefined) return;
    if (reason === "provider_failed" && !roundSpent(next)) {
      await waitPending(personId, reason);
      return;
    }
    await lockPerson(personId);
    await applyQualification({ personId, status: "ai_failed", reason, icpId, icpVersion });
    await dropIntent(personId);
    await publishDecision(personId);
  });
}

/**
 * The lead's next attempt against this audience at this version, stored in the caller's run: a
 * repeat moves it no further.
 */
async function moveAttempt(input: Held & { icpId: string }) {
  const { workspaceId, personId, icpId, icpVersion, attempt = 1 } = input;
  const next = attempt + 1;
  const where = { personId, icpId, icpVersion, attempt: { lt: next } };
  const { count } = await tenantClient.assessmentAttempt.updateMany({
    where,
    data: { attempt: next },
  });
  if (count === 0) {
    const data = [{ workspaceId, personId, icpId, icpVersion, attempt: next }];
    await tenantClient.assessmentAttempt.createMany({ data, skipDuplicates: true });
  }
  return next;
}

/**
 * A pending lead given the reason it waits, with the snapshot it waits with (README "A new
 * assessment"); a lead decided at an older ICP version stays as it was.
 */
async function waitPending(personId: string, reason: string) {
  const lead = await getLead(personId);
  if (lead.qualificationStatus !== "pending") return;
  const snapshotId = lead.currentScoreSnapshotId ?? undefined;
  await applyQualification({ personId, status: "pending", reason, snapshotId });
}
