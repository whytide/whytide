// The cheap drops before any profile read (README.md "Processing"; docs/flows.md), in the step's
// tenant run: a company page (no person, so no hash), the workspace's own staff by the headline, a
// competitor's staff by the headline (noise.ts), an erased or rejected candidate's hash (contacts'),
// and an engagement the workspace knows by its dedupe key, as the watermark's own engager staged
// again. The dropped rows are deleted and counted. A triaged run's rest go to the triage in their
// staged order (domain/triage/, signals-triage-ai). In a run started before it, recruiters and job
// seekers by the headline are dropped too, and the rest come in the rules' read order (gamma-p5-040),
// so that a run its budget stops has read the likeliest first, each with a request file for
// linkedin's profile read, written after the run. The audience is the run's: its agent's, else the
// default (agents.ts, gamma-p5-045).
import { isHashed, normalizeLinkedinUrl } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import type { Icp } from "@whytide/icp";
import { getCompanyDomain } from "@whytide/onboarding";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import { icpTitleTokens, titleFits } from "@whytide/qualification";
import { findOrganization, findWorkspace } from "@whytide/tenancy";
import { sourceKind } from "../../sources/registry.ts";
import { audienceOf } from "../agents.ts";
import { addCounts, type RunRef } from "../runs.ts";
import { READ_FIRST } from "../schedule/constants.ts";
import { profileKeys } from "./keys.ts";
import {
  COMPETITOR_KIND,
  competitorsOf,
  type NoiseReason,
  type NoiseRules,
  noiseRules,
} from "./noise.ts";
import { dedupeKeyOf, ownCompanyRule } from "./rules.ts";

/** A candidate to read: its staging row's id and the profile's URL, which only its request file holds. */
export type Selected = { readonly id: string; readonly profileUrl: string };
type Drop = "dropped_company" | "dropped_own" | NoiseReason | "dropped_hashed" | "dropped_known";
/** A staged candidate as its rank reads it. */
type Ranked = { readonly reaction: string; readonly headline: string };

/** The own-employee rule's name, read outside any run: the organization's, else the workspace's. */
export async function ownCompanyName(workspaceId: string): Promise<string | null> {
  const workspace = await findWorkspace(workspaceId);
  if (workspace === null) return null;
  const organization = await findOrganization(workspace.organizationId);
  return organization?.name.trim() || workspace.name.trim() || null;
}

/**
 * The noise rules of the ICP's audience, in the workspace's tenant run, its competitors read once:
 * every competitor_engagement source's config, by the kind's name (gamma-p5-025's kind).
 */
export async function noiseRulesOf(icp: Pick<Icp, "titles" | "mustHaves">): Promise<NoiseRules> {
  const sources = await tenantClient.signalSource.findMany({
    where: { kind: COMPETITOR_KIND },
    select: { config: true },
  });
  return noiseRules(icp, competitorsOf(sources.map(({ config }) => config)));
}

/**
 * The rules' read rank of a candidate (gamma-p5-040): 0 for an author or a commenter, 1 for a reactor
 * whose staged headline passes the audience's title rule (qualification's titleFits), 2 for the rest.
 */
export function rankOf(titles: readonly string[]): (candidate: Ranked) => 0 | 1 | 2 {
  const targets = icpTitleTokens(titles);
  return ({ reaction, headline }) => {
    if (READ_FIRST.includes(reaction)) return 0;
    return titleFits(headline.trim(), targets) ? 1 : 2;
  };
}

/**
 * The run's candidates after the cheap drops, oldest staged first, for the triage when `triaged`;
 * else after the recruiters and job seekers too, in the rules' read order (rankOf, the run's
 * audience), oldest staged first within each rank. None when the source is gone.
 */
export async function selectCandidates(
  { workspaceId, sourceId, runId, playbookId }: RunRef,
  ownName: string | null,
  triaged = false,
): Promise<Selected[]> {
  const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
  if (source === null) return [];
  const { event } = sourceKind(source.kind);
  // The source's post, for a row staged before gamma-p5-020; every other row names its own.
  const objectUrl = event.objectOf?.(source.config) ?? "";
  const own = ownCompanyRule({ domain: await getCompanyDomain(), name: ownName });
  const { icp } = await audienceOf(workspaceId, playbookId);
  const noise = await noiseRulesOf(icp);
  const noisy = triaged ? noise.competitor : noise.headline;
  const rank: (candidate: Ranked) => number = triaged ? () => 0 : rankOf(icp.titles);
  const staged = await tenantClient.signalCandidate.findMany({
    where: { runId },
    orderBy: { id: "asc" },
  });
  const byUrl = await isHashed({ linkedinUrls: staged.map((c) => c.profileUrl) });
  const byId = await isHashed({ providerIds: staged.map((c) => c.providerMemberRef) });
  const keyOf = (c: (typeof staged)[number]) => {
    const object = c.objectUrl ?? objectUrl;
    return dedupeKeyOf({
      kind: event.kind,
      actor: c.providerMemberRef,
      objectUrl: object,
      role: c.reaction,
    });
  };
  const known = await tenantClient.signalEvent.findMany({
    where: { dedupeKey: { in: staged.map(keyOf) } },
    select: { dedupeKey: true },
  });
  const knownKeys = new Set(known.map(({ dedupeKey }) => dedupeKey));
  const counts: Record<Drop, number> = {
    dropped_company: 0,
    dropped_own: 0,
    dropped_recruiter: 0,
    dropped_job_seeker: 0,
    dropped_competitor: 0,
    dropped_hashed: 0,
    dropped_known: 0,
  };
  const dropped: string[] = [];
  const selected: (Selected & { readonly rank: number })[] = [];
  for (const candidate of staged) {
    const { id, profileUrl, headline, providerMemberRef } = candidate;
    const reason = noisy(headline);
    let drop: Drop | null = null;
    if (normalizeLinkedinUrl(profileUrl) === null) drop = "dropped_company";
    else if (own(headline)) drop = "dropped_own";
    else if (reason !== null) drop = reason;
    else if (byUrl.has(profileUrl) || byId.has(providerMemberRef)) drop = "dropped_hashed";
    else if (knownKeys.has(keyOf(candidate))) drop = "dropped_known";
    if (drop === null) selected.push({ id, profileUrl, rank: rank(candidate) });
    else {
      counts[drop] += 1;
      dropped.push(id);
    }
  }
  await tenantClient.signalCandidate.deleteMany({ where: { id: { in: dropped } } });
  await addCounts(runId, counts);
  // A stable sort: the staged order holds within each rank.
  return selected.sort((a, b) => a.rank - b.rank).map(({ id, profileUrl }) => ({ id, profileUrl }));
}

/** Each selected candidate's request file, `{ profileUrl }`, under the run's folder in raw/. */
export async function writeRequests(
  workspaceId: string,
  runId: string,
  selected: readonly Selected[],
): Promise<void> {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  for (const { id, profileUrl } of selected) {
    const key = profileKeys(runId, id).requestKey;
    const body = JSON.stringify({ profileUrl });
    await files.put({ workspaceId, key, body, contentType: "application/json" });
  }
}
