// The lead's audience (README "The batch"; gamma-p5-050): a lead is judged against the audience of
// the agent that found it, its first signal source's agent, whatever the agent's status; a lead
// with no signal source, or whose source is in no agent, against the workspace's default audience.
// And the batch's selection, per workspace: per audience with targeting, the leads pending for it
// or decided against it at an older version, each given to its own audience; one whose audience has
// no targeting is left as it is. One rule gives both (review-gaps-2): the agents' sources, read once,
// each with its agent's audience, which names a lead's audience and filters contacts' query, so
// each audience's query answers its own pending leads only. Everything runs in the caller's tenant
// run; playbooks' and icp's readers too.
import {
  firstSignalSource,
  getLead,
  type Lead,
  leadsPendingQualification,
  type SourceFilter,
} from "@whytide/contacts";
import { type Icp, listAudiences, readIcpForScoring } from "@whytide/icp";
import { isAppError } from "@whytide/platform";
import { listPlaybooks, sourcesOf } from "@whytide/playbooks";
import { retiredDecisions } from "./reassess/index.ts";

/** What the audience reads of a lead: its sources, the first one first. */
type Sourced = Pick<Lead, "sources">;
/** An audience the batch assesses against: its ICP, and whether it is the workspace's default. */
export type Target = { readonly icp: Icp; readonly isDefault: boolean };
/** A lead's audience by the rule, and the filter of contacts' query that takes its leads. */
export type Resolver = {
  /** The lead's audience's id: an agent's, or the default. */
  readonly of: (lead: Sourced) => string;
  /** The filter on a lead's first signal source that takes the leads whose audience is in `ids`. */
  readonly leadsOf: (ids: ReadonlySet<string>) => SourceFilter;
};
/** The workspace's audiences as the batch reads them, once per batch. */
export type Audiences = Resolver & {
  readonly defaultId: string;
  /** The audiences with targeting, by id: an audience never saved has none and filters nothing. */
  readonly targeted: ReadonlyMap<string, Target>;
};
/** A lead to assess, with the audience it is assessed against. */
export type Selected = { readonly lead: Lead; readonly icpId: string; readonly icp: Icp };

/**
 * The rule among the workspace's `audiences`, with `held`, each agent's source and that agent's
 * audience (agentSources): a lead's audience is its first signal source's agent's, else the
 * default; an id the workspace does not hold is the default too.
 */
export function audienceResolver(
  audiences: readonly { readonly id: string; readonly isDefault: boolean }[],
  held: ReadonlyMap<string, string>,
): Resolver {
  const defaultId = audiences.find(({ isDefault }) => isDefault)?.id ?? "";
  const known = new Set(audiences.map(({ id }) => id));
  const ofSource = (ref: string | undefined) => {
    const icpId = ref === undefined ? undefined : held.get(ref);
    return icpId !== undefined && known.has(icpId) ? icpId : defaultId;
  };
  const refs = [...held.keys()];
  return {
    of: (lead) => ofSource(firstSignalSource(lead.sources)),
    // With the default, every lead but those of an agent's source outside `ids`; else those of an
    // agent's source inside them.
    leadsOf: (ids) =>
      ids.has(defaultId)
        ? { notIn: refs.filter((ref) => !ids.has(ofSource(ref))) }
        : { in: refs.filter((ref) => ids.has(ofSource(ref))) },
  };
}

/**
 * Each source an agent holds, any agent's status, with that agent's audience id: a source belongs to
 * one agent (playbooks' unique key). An agent with no source is not read.
 */
export async function agentSources(): Promise<Map<string, string>> {
  const held = new Map<string, string>();
  for (const { id, icpId, sourceCount } of await listPlaybooks()) {
    if (sourceCount === 0) continue;
    for (const ref of await sourcesOf(id)) held.set(ref, icpId);
  }
  return held;
}

/** The lead's audience's id, by the rule, read now: what a member's press assesses it against. */
export async function audienceOfLead(lead: Sourced): Promise<string> {
  return audienceResolver(await listAudiences(), await agentSources()).of(lead);
}

/** The workspace's audiences, each read once, the default made on the first read as icp does. */
export async function readAudiences(workspaceId: string): Promise<Audiences> {
  const listed = await listAudiences();
  const targeted = new Map<string, Target>();
  for (const { id, isDefault } of listed) {
    const { icp } = await readIcpForScoring(workspaceId, id);
    if (hasTargeting(icp)) targeted.set(id, { icp, isDefault });
  }
  const defaultId = listed.find(({ isDefault }) => isDefault)?.id ?? "";
  return { defaultId, targeted, ...audienceResolver(listed, await agentSources()) };
}

/** The workspace's default audience's id. */
export async function defaultAudienceId(): Promise<string> {
  return (await listAudiences()).find(({ isDefault }) => isDefault)?.id ?? "";
}

/**
 * The audience the person's lead was decided against, whose criteria score its snapshot; undefined,
 * the default, for a person without a lead or a lead decided before audiences.
 */
export async function decidedAudience(personId: string): Promise<string | undefined> {
  const lead = await getLead(personId).catch((error: unknown) => {
    if (isAppError(error) && error.code === "lead_not_found") return null;
    throw error;
  });
  return lead?.icpIdScored ?? undefined;
}

/**
 * Up to `limit` leads to assess, oldest first, each with its audience: per audience with targeting,
 * contacts' pending leads of that audience by the rule, and its leads decided against it below its
 * version (for the default, also those decided before audiences and those a retired rule decided:
 * domain/reassess/) whose audience by the rule has targeting; `limit` at most each, so the oldest
 * `limit` of all are among them. Each lead goes to its own audience; one whose audience has no
 * targeting is never read, so it stays as it is and holds back no other audience's, however many.
 */
export async function selectLeads(audiences: Audiences, limit: number): Promise<Selected[]> {
  const decidedSources = audiences.leadsOf(new Set(audiences.targeted.keys()));
  const candidates = new Map<string, Lead>();
  for (const [icpId, { icp, isDefault }] of audiences.targeted) {
    const icpVersion = icp.version;
    const more = isDefault ? { isDefault, ...(await retiredDecisions(icpVersion)) } : {};
    const pendingSources = audiences.leadsOf(new Set([icpId]));
    const leads = await leadsPendingQualification({
      limit,
      icpId,
      icpVersion,
      pendingSources,
      decidedSources,
      ...more,
    });
    for (const lead of leads) candidates.set(lead.personId, lead);
  }
  const selected: Selected[] = [];
  for (const lead of [...candidates.values()].sort(byAge)) {
    if (selected.length === limit) break;
    const icpId = audiences.of(lead);
    const target = audiences.targeted.get(icpId);
    if (target !== undefined) selected.push({ lead, icpId, icp: target.icp });
  }
  return selected;
}

/** Whether the ICP has targeting: a list, the must-haves or the disqualifiers. */
export function hasTargeting(icp: Icp): boolean {
  const { titles, seniorities, industries, sizeRanges, countries, mustHaves, disqualifiers } = icp;
  const lists = [titles, seniorities, industries, sizeRanges, countries];
  return lists.some((list) => list.length > 0) || `${mustHaves}${disqualifiers}`.trim() !== "";
}

/** Oldest first, then by person id: contacts' order. */
function byAge(a: Lead, b: Lead): number {
  const age = a.createdAt.getTime() - b.createdAt.getTime();
  return age !== 0 ? age : a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0;
}
