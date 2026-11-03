// The batch's activities (README "The batch", docs/flows.md): each is one database step in one tenant
// run, or the model call outside any, so no run is held across a call that leaves the process and
// credits' organization lock lasts one step. Inputs and outputs carry ids, versions and codes only:
// the verdicts and their evidence stay in the snapshot.
import {
  applyQualification,
  getCompany,
  getLead,
  getPerson,
  leadsPendingQualification,
} from "@whytide/contacts";
import { type TenantClient, tenantClient, withTenant } from "@whytide/db";
import { type Icp, readIcpForScoring } from "@whytide/icp";
import {
  type ActivityContext,
  credits,
  isAppError,
  servicePrincipal,
  startWorkflow,
} from "@whytide/platform";
import { listWorkspaceIds } from "@whytide/tenancy";
import { assessmentModel, assessPerson } from "../domain/assess/assess-person.ts";
import { givenClient } from "../domain/client.ts";
import { publishDecision } from "../domain/decision.ts";
import { prepareHardFilters } from "../domain/hard-filters/index.ts";
import { scoreSnapshot } from "../domain/score/score-snapshot.ts";
import { buildWhy } from "../domain/why/index.ts";
import { batchStart } from "../events.ts";
import { prices } from "../prices.ts";
import { settings } from "../settings.ts";

type Context = ActivityContext<TenantClient>;
type Lead = {
  readonly workspaceId: string;
  readonly personId: string;
  readonly icpVersion: number;
};
/** The lead with its reservation and the attempt it is for; 1 when an older history names none. */
type Held = Lead & { readonly usageId: string; readonly attempt?: number };
const CODE = /^[a-z][a-z0-9_]{0,39}$/;
/** A lead the provider fails at this attempt, or a later one, is ai_failed; before, it waits. */
const LAST_ATTEMPT = 3;

/**
 * One assessment per person, ICP version, model, prompt version and attempt: a repeat reserves
 * nothing more. The first attempt's key has no attempt, as before attempts were counted.
 */
export function assessmentKey(input: {
  personId: string;
  icpVersion: number;
  modelId: string;
  promptVersion: number;
  attempt?: number;
}): string {
  const { personId, icpVersion, modelId, promptVersion, attempt = 1 } = input;
  const key = `qual:${personId}:${icpVersion}:${modelId}:${promptVersion}`;
  return attempt === 1 ? key : `${key}:${attempt}`;
}

/**
 * The tick's activity: each workspace with a lead to assess against a saved ICP gets its batch
 * started, unless one runs; the check is a run of the workspace's own. A workspace that fails leaves
 * the others started, and the tick then fails with its code. The counts only.
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

/** In the workspace's own run: its ICP has targeting (an unsaved one has none) and a lead waits. */
function hasWork(workspaceId: string): Promise<boolean> {
  const tenant = { workspaceId, principal: servicePrincipal("qualification") };
  const check = async () => {
    const { icp } = await readIcpForScoring(workspaceId);
    if (!targeted(icp)) return false;
    const leads = await leadsPendingQualification({ limit: 1, icpVersion: icp.version });
    return leads.length > 0;
  };
  return withTenant(tenant, check, { client: givenClient() });
}

function targeted(icp: Icp): boolean {
  const { titles, seniorities, industries, sizeRanges, countries, mustHaves, disqualifiers } = icp;
  const lists = [titles, seniorities, industries, sizeRanges, countries];
  return lists.some((list) => list.length > 0) || `${mustHaves}${disqualifiers}`.trim() !== "";
}

/**
 * The batch's first step, one run: the ICP read and its filters prepared once, the leads selected
 * (pending, or decided at an older ICP version), each one filtered; a miss is hard_filtered with the
 * compared values in its why, and its event. The persons who passed, oldest first.
 */
export async function filterLeads(_input: unknown, context: Context) {
  const { workspaceId } = context;
  return context.tenant(async () => {
    const { icp } = await readIcpForScoring(workspaceId);
    const icpVersion = icp.version;
    const limit = settings.QUALIFICATION_BATCH_SIZE;
    const leads = await leadsPendingQualification({ limit, icpVersion });
    const filters = prepareHardFilters(icp);
    const personIds: string[] = [];
    for (const { personId } of leads) {
      const person = await getPerson(personId);
      const company = person.companyId === null ? null : await getCompany(person.companyId);
      const result = filters(person, company);
      if (result.passed) {
        personIds.push(personId);
        continue;
      }
      const why = buildWhy({ verdicts: [], criteria: [], disqualifiers: [], hardFilter: result });
      const { reason } = result;
      await applyQualification({ personId, status: "hard_filtered", reason, why, icpVersion });
      await publishDecision(personId);
    }
    return { icpVersion, personIds, filtered: leads.length - personIds.length };
  });
}

/**
 * One assessment reserved in a run of its own, under the lead's attempt's key, credits' lock held for
 * that run only. Too few credits: the lead waits, with status_reason insufficient_credits if pending,
 * and the batch stops.
 */
export async function reserveLead(
  input: Lead,
  context: Context,
): Promise<
  { status: "reserved"; usageId: string; attempt: number } | { status: "insufficient_credits" }
> {
  const { personId, icpVersion } = input;
  const model = await assessmentModel();
  const action = prices["qualification.assessment"];
  const { workspaceId } = context;
  return context.tenant(async () => {
    const where = { personId, icpVersion };
    const stored = await tenantClient.assessmentAttempt.findFirst({ where });
    const attempt = stored?.attempt ?? 1;
    const idempotencyKey = assessmentKey({ personId, icpVersion, ...model, attempt });
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
 * The model's assessment, outside any run (assessPerson opens its own): the snapshot, ai_failed with
 * its reason as a code, or stale when the ICP moved since the batch read it.
 */
export async function assessLead(
  input: Lead,
  context: Context,
): Promise<
  | { status: "assessed"; snapshotId: string }
  | { status: "ai_failed"; reason: string }
  | { status: "stale" }
> {
  const { personId, icpVersion } = input;
  const { workspaceId, tenant } = context;
  const client = givenClient();
  const call = client === undefined ? undefined : { client };
  try {
    const result = await assessPerson({ personId, icpVersion }, { workspaceId, tenant, call });
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
 * lead's event. An ICP that moved since the assessment releases the reservation instead. A
 * reservation past its 24-hour lease rolls the run back: released, the lead's attempt moved, and the
 * workflow reserves again under the next attempt's key.
 */
export async function commitLead(
  input: Held & { snapshotId: string },
  context: Context,
): Promise<{ status: "committed" | "stale" | "lease_expired" }> {
  try {
    return await context.tenant(async () => {
      try {
        await scoreSnapshot(input.snapshotId);
      } catch (error) {
        // Thrown before any write: the run goes on.
        if (!isAppError(error) || error.code !== "icp_version_stale") throw error;
        await credits.release(input.usageId);
        return { status: "stale" };
      }
      await credits.commit(input.usageId);
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
 * again. Given a reason, the lead is ai_failed at the batch's version, unless the provider failed
 * before the last attempt: then it waits for a later batch, with the reason if pending.
 */
export async function releaseLead(input: Held & { reason?: string }, context: Context) {
  await context.tenant(async () => {
    await credits.release(input.usageId);
    const next = await moveAttempt(input);
    const { personId, icpVersion, reason } = input;
    if (reason === undefined) return;
    if (reason === "provider_failed" && next <= LAST_ATTEMPT) {
      await waitPending(personId, reason);
      return;
    }
    await applyQualification({ personId, status: "ai_failed", reason, icpVersion });
    await publishDecision(personId);
  });
}

/** The lead's next attempt at this version, stored in the caller's run: a repeat moves it no further. */
async function moveAttempt({ workspaceId, personId, icpVersion, attempt = 1 }: Held) {
  const next = attempt + 1;
  const where = { personId, icpVersion, attempt: { lt: next } };
  const { count } = await tenantClient.assessmentAttempt.updateMany({
    where,
    data: { attempt: next },
  });
  if (count === 0) {
    const data = [{ workspaceId, personId, icpVersion, attempt: next }];
    await tenantClient.assessmentAttempt.createMany({ data, skipDuplicates: true });
  }
  return next;
}

/** A pending lead given the reason it waits; a lead decided at an older ICP version stays as it was. */
async function waitPending(personId: string, reason: string) {
  if ((await getLead(personId)).qualificationStatus !== "pending") return;
  await applyQualification({ personId, status: "pending", reason });
}
