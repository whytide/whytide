// icp's commands and its public queries (README "Commands"), in the caller's tenant run: they read
// and write through tenantClient, the run's transaction scoped to its workspace (core/packages/db
// README "The tenant transaction and the scoped client"), and open no run of their own. The api's
// handlers call them in the request's run, qualification's activity (alpha-p6) in its own. A
// workspace holds several audiences; a call without an `icpId` acts on its default, as before them.
import { outboxWriter, tenantClient } from "@whytide/db";
import {
  AppError,
  canWriteOwned,
  currentTenant,
  newId,
  type Principal,
  publish,
  tenantErrors,
} from "@whytide/platform";
import { errors } from "../errors.ts";
import { events } from "../events.ts";
import { ids } from "../ids.ts";
import { permissions } from "../permissions.ts";
import { settings } from "../settings.ts";
import { AUDIENCES_LOCK, SYSTEM_CREATOR } from "./constants.ts";
import {
  CRITERION_KEYS,
  type Criterion,
  DEFAULT_CRITERIA,
  SENIORITIES,
  SIZE_RANGES,
} from "./lists.ts";
import { audienceOwner } from "./owner.ts";
import {
  checkWeights,
  type IcpFields,
  type Targeting,
  targetingChanged,
  targetingOf,
} from "./rules.ts";

/** An audience: its name, its targeting fields and its version. The default is the workspace's ICP. */
export type Icp = Targeting & {
  readonly id: string;
  readonly name: string;
  /** 1 when created; one more with every targeting change, never for the name alone. */
  readonly version: number;
  readonly updatedAt: Date;
};
/** What qualification scores against: the ICP and its six criteria, in one object. */
export type IcpForScoring = { readonly icp: Icp; readonly criteria: Criterion[] };
/** An audience as findAudience answers it; `createdBy` null on a row made before gamma-p3-020. */
export type Audience = {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly createdBy: string | null;
  readonly version: number;
};
/** An audience as listAudiences and createAudience answer it. */
export type AudienceSummary = Audience & { readonly updatedAt: Date };

/** A row of `icps` as the client returns it, the closed lists as plain strings. */
type IcpRow = Omit<Icp, "seniorities" | "sizeRanges"> & {
  seniorities: string[];
  sizeRanges: string[];
  isDefault: boolean;
  createdBy: string | null;
};

/** The columns of an Audience, and of an AudienceSummary. */
const AUDIENCE_FIELDS = {
  id: true,
  name: true,
  isDefault: true,
  createdBy: true,
  version: true,
} as const;
const SUMMARY_FIELDS = { ...AUDIENCE_FIELDS, updatedAt: true } as const;

/**
 * The audience `icpId`, else the workspace's default, which the first read creates empty with the
 * six default criteria; an id the workspace does not hold is icp_not_found.
 */
export async function getIcp(workspaceId: string, icpId?: string): Promise<Icp> {
  inRunOf(workspaceId);
  return toIcp(await audienceRow(icpId));
}

/** The audience's six criteria, in the order of CRITERION_KEYS; the default's first read creates them. */
export async function getCriteria(workspaceId: string, icpId?: string): Promise<Criterion[]> {
  inRunOf(workspaceId);
  return criteriaOf((await audienceRow(icpId)).id);
}

/**
 * For qualification, in its tenant run: the audience and its criteria in one call, as getIcp makes
 * them; without `icpId`, the default.
 */
export async function readIcpForScoring(
  workspaceId: string,
  icpId?: string,
): Promise<IcpForScoring> {
  const icp = await getIcp(workspaceId, icpId);
  return { icp, criteria: await criteriaOf(icp.id) };
}

/** The workspace's audiences, the default first (made on the first read), then by name. */
export async function listAudiences(): Promise<AudienceSummary[]> {
  await ensureDefault();
  return tenantClient.icp.findMany({
    select: SUMMARY_FIELDS,
    orderBy: [{ isDefault: "desc" }, { name: "asc" }, { id: "asc" }],
  });
}

/** The audience `icpId` of the run's workspace, or null: for an agent pointing at one. */
export async function findAudience(icpId: string): Promise<Audience | null> {
  return tenantClient.icp.findFirst({ where: { id: icpId }, select: AUDIENCE_FIELDS });
}

/**
 * A new audience, not the default, version 1, with the six default criteria and its creator. The
 * workspace's lock is held until the run commits, so two creates at once count one after the other:
 * past ICP_MAX_AUDIENCES_PER_WORKSPACE (settings.ts), the default included, is icp_audience_limit,
 * `details.limit` the value configured.
 */
export async function createAudience(input: {
  readonly name: string;
  readonly createdBy: string;
}): Promise<AudienceSummary> {
  const { workspaceId } = currentTenant();
  await ensureDefault();
  const lock = `${AUDIENCES_LOCK}:${workspaceId}`;
  await tenantClient.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
  const limit = settings.ICP_MAX_AUDIENCES_PER_WORKSPACE;
  if ((await tenantClient.icp.count({})) >= limit) {
    throw new AppError(errors.icp_audience_limit, { details: { limit } });
  }
  const id = newId(ids.icp);
  const row = { id, workspaceId, name: input.name.trim(), createdBy: input.createdBy };
  const created = await tenantClient.icp.create({
    data: { ...row, isDefault: false },
    select: SUMMARY_FIELDS,
  });
  await createCriteria(id);
  return created;
}

/**
 * Who `created_by` names: `system` for a service's run, the worker's or the script's; else the user
 * the request acts for, the member.
 */
export function creatorOf(principal: Principal): string {
  return principal.actorType === "service" ? SYSTEM_CREATOR : principal.userId;
}

/**
 * Saves the audience's name and targeting fields, the default's without `icpId`. A targeting change
 * moves its version by one and publishes icp.audience_updated with it, and icp.updated too for the
 * default, in the same transaction; a value off a closed list writes nothing.
 */
export async function saveIcp(fields: IcpFields, icpId?: string): Promise<Icp> {
  const next = targetingOf(fields);
  const { workspaceId } = currentTenant();
  const id = await lockedIcpId(icpId);
  const row = await tenantClient.icp.findFirstOrThrow({ where: { id } });
  const stored = toIcp(row);
  const changed = targetingChanged(stored, next);
  const version = changed ? stored.version + 1 : stored.version;
  const data = { name: fields.name.trim(), ...next, version };
  const saved = await tenantClient.icp.update({ where: { id }, data });
  if (changed) {
    const outbox = outboxWriter(tenantClient, workspaceId);
    if (row.isDefault) await publish(outbox, events["icp.updated"], { workspaceId, version });
    await publish(outbox, events["icp.audience_updated"], { workspaceId, icpId: id, version });
  }
  return toIcp(saved);
}

/** Saves the audience's criteria by key, so the six keys stay fixed; the weights sum to 100. */
export async function saveCriteria(
  criteria: readonly Criterion[],
  icpId?: string,
): Promise<Criterion[]> {
  checkWeights(criteria);
  const id = await lockedIcpId(icpId);
  for (const { key, weight, isMust, enabled } of criteria) {
    const data = { weight, isMust, enabled };
    await tenantClient.criterion.updateMany({ where: { icpId: id, key }, data });
  }
  return criteriaOf(id);
}

/**
 * The id of the audience `icpId`, else of the default, its row locked until the run commits, once
 * the caller may write it: every write of an audience comes here. Its owner writes it, and a holder
 * of icp.manage writes every one (platform's canWriteOwned; README "Decided here"); anyone else is
 * forbidden before anything is written, and the run rolls back a default its read just created. Of
 * two saves at once, of an audience or of its criteria, the second waits for the first and reads
 * what it committed: their row updates never interleave, so they cannot deadlock.
 */
export async function lockedIcpId(icpId?: string): Promise<string> {
  const row = await audienceRow(icpId);
  const { workspaceId, principal } = currentTenant();
  const owned = { ownerUserId: audienceOwner(row), manageAction: permissions["icp.manage"] };
  const decision = canWriteOwned(principal, owned);
  if (decision !== "allow") throw new AppError(decision);
  await tenantClient.$queryRaw`
    SELECT id FROM icps WHERE id = ${row.id} AND workspace_id = ${workspaceId} FOR UPDATE`;
  return row.id;
}

/** The audience `icpId` of the run's workspace, else icp_not_found; without one, the default. */
async function audienceRow(icpId?: string): Promise<IcpRow> {
  if (icpId === undefined) return ensureDefault();
  const found = await tenantClient.icp.findFirst({ where: { id: icpId } });
  if (found === null) throw new AppError(errors.icp_not_found);
  return found;
}

/**
 * The run's default audience, created with its criteria when there is none, its creator the run's.
 * Two first reads at once: the second insert waits on icps_default for the first one's commit and
 * skips it (ON CONFLICT DO NOTHING), then reads that row.
 */
async function ensureDefault(): Promise<IcpRow> {
  const where = { isDefault: true };
  const found = await tenantClient.icp.findFirst({ where });
  if (found !== null) return found;
  const { workspaceId, principal } = currentTenant();
  const icpId = newId(ids.icp);
  const icp = { id: icpId, workspaceId, isDefault: true, createdBy: creatorOf(principal) };
  const { count } = await tenantClient.icp.createMany({ data: [icp], skipDuplicates: true });
  if (count === 1) await createCriteria(icpId);
  return tenantClient.icp.findFirstOrThrow({ where });
}

/** A new audience's six criteria, with F04 §4.3's weights. */
async function createCriteria(icpId: string): Promise<void> {
  const { workspaceId } = currentTenant();
  const data = DEFAULT_CRITERIA.map((row) => ({
    ...row,
    id: newId(ids.criterion),
    workspaceId,
    icpId,
  }));
  await tenantClient.criterion.createMany({ data });
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
