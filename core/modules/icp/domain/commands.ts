// icp's commands and its public query (README "Commands"), in the caller's tenant run: they read and
// write through tenantClient, the run's transaction scoped to its workspace (core/packages/db README
// "The tenant transaction and the scoped client"), and open no run of their own. The api's handlers
// call them in the request's run, qualification's activity (alpha-p6) in its own.
import { outboxWriter, tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId, publish, tenantErrors } from "@whytide/platform";
import { events } from "../events.ts";
import { ids } from "../ids.ts";
import {
  CRITERION_KEYS,
  type Criterion,
  DEFAULT_CRITERIA,
  SENIORITIES,
  SIZE_RANGES,
} from "./lists.ts";
import {
  checkWeights,
  type IcpFields,
  type Targeting,
  targetingChanged,
  targetingOf,
} from "./rules.ts";

/** The workspace's one ICP: its name, its targeting fields and its version. */
export type Icp = Targeting & {
  readonly id: string;
  readonly name: string;
  /** 1 when created; one more with every targeting change, never for the name alone. */
  readonly version: number;
  readonly updatedAt: Date;
};
/** What qualification scores against: the ICP and its six criteria, in one object. */
export type IcpForScoring = { readonly icp: Icp; readonly criteria: Criterion[] };

/** A row of `icps` as the client returns it, the closed lists as plain strings. */
type IcpRow = Omit<Icp, "seniorities" | "sizeRanges"> & {
  seniorities: string[];
  sizeRanges: string[];
};

/** The workspace's ICP; the first read creates it empty, with the six default criteria. */
export async function getIcp(workspaceId: string): Promise<Icp> {
  inRunOf(workspaceId);
  return toIcp(await ensureIcp());
}

/** The ICP's six criteria, in the order of CRITERION_KEYS; the first read creates them. */
export async function getCriteria(workspaceId: string): Promise<Criterion[]> {
  inRunOf(workspaceId);
  return criteriaOf((await ensureIcp()).id);
}

/** For qualification, in its tenant run: the ICP and its criteria in one call, as getIcp makes them. */
export async function readIcpForScoring(workspaceId: string): Promise<IcpForScoring> {
  const icp = await getIcp(workspaceId);
  return { icp, criteria: await criteriaOf(icp.id) };
}

/**
 * Saves the name and the targeting fields. A targeting change moves the version by one and publishes
 * icp.updated with it, in the same transaction; a value off a closed list writes nothing.
 */
export async function saveIcp(fields: IcpFields): Promise<Icp> {
  const next = targetingOf(fields);
  const { workspaceId } = currentTenant();
  const id = await lockedIcpId();
  const stored = toIcp(await tenantClient.icp.findFirstOrThrow({ where: { id } }));
  const changed = targetingChanged(stored, next);
  const version = changed ? stored.version + 1 : stored.version;
  const data = { name: fields.name.trim(), ...next, version };
  const saved = await tenantClient.icp.update({ where: { id }, data });
  if (changed) {
    const outbox = outboxWriter(tenantClient, workspaceId);
    await publish(outbox, events["icp.updated"], { workspaceId, version });
  }
  return toIcp(saved);
}

/** Saves the criteria by key, so the six keys stay fixed; the weights sum to 100. */
export async function saveCriteria(criteria: readonly Criterion[]): Promise<Criterion[]> {
  checkWeights(criteria);
  const icpId = await lockedIcpId();
  for (const { key, weight, isMust, enabled } of criteria) {
    const data = { weight, isMust, enabled };
    await tenantClient.criterion.updateMany({ where: { icpId, key }, data });
  }
  return criteriaOf(icpId);
}

/**
 * The run's ICP, created with its criteria when there is none. Two first reads at once: the second
 * insert waits for the first one's commit and skips it (ON CONFLICT DO NOTHING), then reads that row.
 */
async function ensureIcp(): Promise<IcpRow> {
  const found = await tenantClient.icp.findFirst({});
  if (found !== null) return found;
  const { workspaceId } = currentTenant();
  const icpId = newId(ids.icp);
  const icp = { id: icpId, workspaceId };
  const { count } = await tenantClient.icp.createMany({ data: [icp], skipDuplicates: true });
  if (count === 1) {
    const data = DEFAULT_CRITERIA.map((row) => ({
      ...row,
      id: newId(ids.criterion),
      workspaceId,
      icpId,
    }));
    await tenantClient.criterion.createMany({ data });
  }
  return tenantClient.icp.findFirstOrThrow({});
}

/**
 * The run's ICP's id, its row locked until the run commits. Of two saves at once, of the ICP or of
 * its criteria, the second waits for the first and reads what it committed: their row updates never
 * interleave, so they cannot deadlock.
 */
export async function lockedIcpId(): Promise<string> {
  const { id } = await ensureIcp();
  const { workspaceId } = currentTenant();
  await tenantClient.$queryRaw`
    SELECT id FROM icps WHERE id = ${id} AND workspace_id = ${workspaceId} FOR UPDATE`;
  return id;
}

async function criteriaOf(icpId: string): Promise<Criterion[]> {
  const rows = await tenantClient.criterion.findMany({ where: { icpId } });
  return CRITERION_KEYS.flatMap((key) => {
    const row = rows.find((candidate) => candidate.key === key);
    return row ? [{ key, weight: row.weight, isMust: row.isMust, enabled: row.enabled }] : [];
  });
}

/** A command works in the caller's run only: another workspace is tenant_mismatch. */
function inRunOf(workspaceId: string): void {
  if (currentTenant().workspaceId !== workspaceId) throw new AppError(tenantErrors.tenant_mismatch);
}

function toIcp(row: IcpRow): Icp {
  return {
    id: row.id,
    name: row.name,
    titles: row.titles,
    seniorities: SENIORITIES.filter((value) => row.seniorities.includes(value)),
    industries: row.industries,
    sizeRanges: SIZE_RANGES.filter((value) => row.sizeRanges.includes(value)),
    countries: row.countries,
    mustHaves: row.mustHaves,
    disqualifiers: row.disqualifiers,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}
