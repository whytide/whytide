// playbooks' commands and readers (README "Commands"), in the caller's tenant run: they read and
// write through tenantClient, the run's transaction scoped to its workspace (core/packages/db README
// "The tenant transaction and the scoped client"), and open no run of their own. The api's handlers
// call them in the request's run; signals (gamma-p5-045), campaigns (gamma-p3-065) and qualification
// (gamma-p5-050) call the readers and detachSource in theirs. An agent's row is locked before its
// sources, in every command that writes both, so two writes of one agent never deadlock. A write of
// an agent is its owner's or playbooks.manage's (lockedPlaybook, gamma-p6-015); an agent paused for
// its owner's removal is resumed by that owner alone (updatePlaybook, gamma-p6-075). The limits are
// the settings' (settings.ts, README "Settings"), and `details.limit` the value configured.
import { outboxWriter, tenantClient } from "@whytide/db";
import { findAudience } from "@whytide/icp";
import { AppError, canWriteOwned, currentTenant, newId, publish } from "@whytide/platform";
import { errors } from "../errors.ts";
import { events } from "../events.ts";
import { ids } from "../ids.ts";
import { permissions } from "../permissions.ts";
import { settings } from "../settings.ts";
import {
  LIVE_STATUSES,
  type PausedReason,
  PLAYBOOKS_LOCK,
  type PlaybookStatus,
  SOURCE_CODES,
  type SourceCode,
  UNIQUE_VIOLATION,
} from "./constants.ts";
import { archivedAtFor, pausedReasonFor, refusalOf, refusesResume, uniqueIds } from "./rules.ts";
import { sourceChecker } from "./source-checker.ts";

/** An agent as the readers answer it. */
export type Playbook = {
  readonly id: string;
  readonly name: string;
  /** icp's audience. */
  readonly icpId: string;
  /** The member who created it. */
  readonly ownerUserId: string;
  readonly status: PlaybookStatus;
  /** Why it is paused, null unless it is: a member's pause, or its owner's removal. */
  readonly pausedReason: PausedReason | null;
  readonly createdAt: Date;
};
/** An agent as listPlaybooks answers it, with the number of sources it holds. */
export type ListedPlaybook = Playbook & { readonly sourceCount: number };
/** Whether the agent may hold the source, and why not: the code setSources would refuse it with. */
export type SourceUse = {
  readonly sourceId: string;
  readonly usable: boolean;
  readonly code: SourceCode | null;
  /** The other agent that holds it, whose name the screen shows; null when none does. */
  readonly heldBy: string | null;
};
export type PlaybookPatch = {
  readonly name?: string;
  readonly icpId?: string;
  readonly status?: PlaybookStatus;
};

const FIELDS = {
  id: true,
  name: true,
  icpId: true,
  ownerUserId: true,
  status: true,
  pausedReason: true,
  createdAt: true,
} as const;
/** An agent that counts against the limit and holds its audience: not archived. */
const LIVE = { status: { in: [...LIVE_STATUSES] } };

/**
 * A new agent, active, owned by `ownerUserId`, created by the run's user; publishes
 * playbooks.playbook_created. The workspace's lock is held until the run commits, so two creates at
 * once check and count one after the other: an audience the workspace does not hold is
 * playbook_icp_not_found, one a live agent has playbook_icp_in_use, and a create past
 * PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE live agents playbook_limit_reached.
 */
export async function createPlaybook(input: {
  readonly name: string;
  readonly icpId: string;
  readonly ownerUserId: string;
}): Promise<Playbook> {
  const { workspaceId, principal } = currentTenant();
  const lock = `${PLAYBOOKS_LOCK}:${workspaceId}`;
  await tenantClient.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
  await assertAudienceFree(input.icpId);
  const limit = settings.PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE;
  if ((await tenantClient.playbook.count({ where: LIVE })) >= limit) {
    throw new AppError(errors.playbook_limit_reached, { details: { limit } });
  }
  const { icpId, ownerUserId } = input;
  const data = {
    id: newId(ids.playbook),
    workspaceId,
    name: input.name.trim(),
    ...{ icpId, ownerUserId, createdBy: principal.userId },
  };
  const created = await guarded(
    () => tenantClient.playbook.create({ data, select: FIELDS }),
    errors.playbook_icp_in_use,
  );
  const payload = { playbookId: created.id, ownerUserId, icpId };
  const outbox = outboxWriter(tenantClient, workspaceId);
  await publish(outbox, events["playbooks.playbook_created"], payload);
  return created;
}

/**
 * Renames the agent, moves it to another audience (checked as a create checks it) or changes its
 * status; publishes playbooks.playbook_updated. A patch that changes none of the three writes and
 * publishes nothing. Archived is final: any later change is playbook_archived. Archiving sets
 * archived_at and deletes the agent's sources, so they and its audience are free again. A pause is
 * the member's (paused_reason `user`); an agent paused already keeps its reason, and one paused for
 * its owner's removal is resumed by that owner alone: anyone else is playbook_owner_removed, before
 * anything is written.
 */
export async function updatePlaybook(playbookId: string, patch: PlaybookPatch): Promise<Playbook> {
  const playbook = await lockedPlaybook(playbookId);
  if (playbook.status === "archived") throw new AppError(errors.playbook_archived);
  const icpId = patch.icpId ?? playbook.icpId;
  const status = patch.status ?? playbook.status;
  const name = patch.name === undefined ? playbook.name : patch.name.trim();
  if (refusesResume(playbook, status, currentTenant().principal.userId)) {
    throw new AppError(errors.playbook_owner_removed);
  }
  const same = name === playbook.name && icpId === playbook.icpId && status === playbook.status;
  if (same) return playbook;
  if (icpId !== playbook.icpId) await assertAudienceFree(icpId);
  const data = {
    ...{ name, icpId, status },
    pausedReason: pausedReasonFor(status, playbook),
    archivedAt: archivedAtFor(status, new Date()),
  };
  const updated = await guarded(
    () => tenantClient.playbook.update({ where: { id: playbook.id }, data, select: FIELDS }),
    errors.playbook_icp_in_use,
  );
  if (status === "archived") {
    await tenantClient.playbookSource.deleteMany({ where: { playbookId: playbook.id } });
  }
  const outbox = outboxWriter(tenantClient, currentTenant().workspaceId);
  const payload = { playbookId: playbook.id, status };
  await publish(outbox, events["playbooks.playbook_updated"], payload);
  return updated;
}

/**
 * Replaces the agent's sources with `sourceIds`, each checked through the source checker: with none
 * registered, playbook_source_checker_missing and nothing written. More than
 * PLAYBOOKS_MAX_SOURCES_PER_AGENT distinct ids is playbook_sources_limit before anything is read; the
 * route's schema caps no set, so that the API's document never depends on the environment, and the
 * api's body limit bounds a request (limits-no-max). A refused id fails the whole set with its code (SOURCE_CODES, in
 * order) and `details.sourceIds`, the ids of that code. A change publishes
 * playbooks.sources_changed. The agent's ids after it, oldest link first.
 */
export async function setSources(
  playbookId: string,
  sourceIds: readonly string[],
): Promise<string[]> {
  const wanted = uniqueIds(sourceIds);
  const limit = settings.PLAYBOOKS_MAX_SOURCES_PER_AGENT;
  if (wanted.length > limit) {
    throw new AppError(errors.playbook_sources_limit, { details: { limit } });
  }
  const playbook = await lockedPlaybook(playbookId);
  if (playbook.status === "archived") throw new AppError(errors.playbook_archived);
  const uses = await usesOf(playbook, wanted);
  for (const code of SOURCE_CODES) {
    const refused = uses.flatMap((use) => (use.code === code ? [use.sourceId] : []));
    if (refused.length > 0) throw new AppError(errors[code], { details: { sourceIds: refused } });
  }
  const where = { playbookId: playbook.id, sourceId: { notIn: wanted } };
  const { count: removed } = await tenantClient.playbookSource.deleteMany({ where });
  const kept = new Set(await sourcesOf(playbook.id));
  // Inserted in one order, so two agents' sets that race wait on each other, never deadlock.
  const added = wanted.filter((sourceId) => !kept.has(sourceId)).sort();
  const { workspaceId } = currentTenant();
  const data = added.map((sourceId) => {
    return { id: newId(ids.playbook_source), workspaceId, playbookId: playbook.id, sourceId };
  });
  await guarded(
    () => tenantClient.playbookSource.createMany({ data }),
    errors.playbook_source_in_use,
    { sourceIds: added },
  );
  if (removed > 0 || added.length > 0) {
    const outbox = outboxWriter(tenantClient, workspaceId);
    await publish(outbox, events["playbooks.sources_changed"], { playbookId: playbook.id });
  }
  return sourcesOf(playbook.id);
}

/**
 * For each id, once, whether the agent may hold the source and the code setSources would answer:
 * the screen offers the usable ones only. playbook_not_found for an agent the workspace does not
 * hold; with no checker registered, playbook_source_checker_missing.
 */
export async function checkSources(
  playbookId: string,
  sourceIds: readonly string[],
): Promise<SourceUse[]> {
  const playbook = await getPlaybook(playbookId);
  if (playbook === null) throw new AppError(errors.playbook_not_found);
  return usesOf(playbook, uniqueIds(sourceIds));
}

/** Deletes the source's link, if any: for signals to call when a source is deleted (gamma-p5-045). */
export async function detachSource(sourceId: string): Promise<void> {
  // Prisma drops an empty where: unchecked, that would be every link.
  if (!sourceId) return;
  await tenantClient.playbookSource.deleteMany({ where: { sourceId } });
}

/** The agent of the run's workspace, or null. */
export async function getPlaybook(playbookId: string): Promise<Playbook | null> {
  if (!playbookId) return null;
  return tenantClient.playbook.findFirst({ where: { id: playbookId }, select: FIELDS });
}

/** The workspace's agents with their sources' counts: the live ones first, oldest first. */
export async function listPlaybooks(): Promise<ListedPlaybook[]> {
  const playbooks = await tenantClient.playbook.findMany({
    select: FIELDS,
    orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
  });
  const links = await tenantClient.playbookSource.findMany({ select: { playbookId: true } });
  return playbooks.map((playbook) => {
    const sourceCount = links.filter((link) => link.playbookId === playbook.id).length;
    return { ...playbook, sourceCount };
  });
}

/** The ids of the agent's sources, oldest link first; none for an agent the workspace does not hold. */
export async function sourcesOf(playbookId: string): Promise<string[]> {
  if (!playbookId) return [];
  const rows = await tenantClient.playbookSource.findMany({
    where: { playbookId },
    select: { sourceId: true },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => row.sourceId);
}

/** The id of the agent that holds the source, or null for a free one. */
export async function playbookOfSource(sourceId: string): Promise<string | null> {
  if (!sourceId) return null;
  const where = { sourceId };
  const row = await tenantClient.playbookSource.findFirst({ where, select: { playbookId: true } });
  return row?.playbookId ?? null;
}

/**
 * The agent, its row locked until the run commits, so two writes of one agent go one after the
 * other; playbook_not_found for one the workspace does not hold. Then whether the caller may write
 * it (README "Decided here"): its owner, or a holder of playbooks.manage, through platform's
 * canWriteOwned; anyone else is forbidden, before anything is written.
 */
async function lockedPlaybook(playbookId: string): Promise<Playbook> {
  const { workspaceId, principal } = currentTenant();
  const locked = playbookId
    ? await tenantClient.$queryRaw<{ id: string }[]>`
        SELECT id FROM playbooks WHERE id = ${playbookId} AND workspace_id = ${workspaceId}
        FOR UPDATE`
    : [];
  const playbook = locked.length > 0 ? await getPlaybook(playbookId) : null;
  if (playbook === null) throw new AppError(errors.playbook_not_found);
  const owned = {
    ownerUserId: playbook.ownerUserId,
    manageAction: permissions["playbooks.manage"],
  };
  const decision = canWriteOwned(principal, owned);
  if (decision !== "allow") throw new AppError(decision);
  return playbook;
}

/** playbook_icp_not_found unless the workspace holds the audience; playbook_icp_in_use if a live agent has it. */
async function assertAudienceFree(icpId: string): Promise<void> {
  if ((await findAudience(icpId)) === null) throw new AppError(errors.playbook_icp_not_found);
  const holder = await tenantClient.playbook.findFirst({
    where: { icpId, ...LIVE },
    select: { id: true },
  });
  if (holder !== null) throw new AppError(errors.playbook_icp_in_use);
}

/** Each id's use by the agent; the checker must be registered, and is asked once for them all. */
async function usesOf(playbook: Playbook, sourceIds: readonly string[]): Promise<SourceUse[]> {
  const check = sourceChecker();
  if (check === undefined) throw new AppError(errors.playbook_source_checker_missing);
  if (sourceIds.length === 0) return [];
  const answers = new Map((await check(sourceIds)).map((answer) => [answer.sourceId, answer]));
  const held = await tenantClient.playbookSource.findMany({
    where: { sourceId: { in: [...sourceIds] }, playbookId: { not: playbook.id } },
    select: { sourceId: true, playbookId: true },
  });
  const holders = new Map(held.map((row) => [row.sourceId, row.playbookId]));
  return sourceIds.map((sourceId) => {
    const heldBy = holders.get(sourceId) ?? null;
    const code = refusalOf(answers.get(sourceId), playbook.ownerUserId, heldBy !== null);
    return { sourceId, usable: code === null, code, heldBy };
  });
}

/**
 * The write, or `code` when a unique index refused it: a race the commands' checks did not see,
 * which aborts the run. The partial index on the live agents' audiences, or the sources' key.
 */
async function guarded<T>(
  write: () => Promise<T>,
  code: string,
  details?: Record<string, unknown>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== UNIQUE_VIOLATION) throw error;
    throw new AppError(code, details === undefined ? { cause: error } : { details, cause: error });
  }
}
