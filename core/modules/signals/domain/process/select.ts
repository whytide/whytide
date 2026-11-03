// The cheap drops before any profile read (README.md "Processing"; docs/flows.md), in the step's
// tenant run: a company page (no person, so no hash), the workspace's own staff by the headline, an
// erased or rejected candidate's hash (contacts'), and an engagement the workspace knows by its dedupe
// key, as the watermark's own engager staged again. The dropped rows are deleted and counted; each of
// the rest gets a request file for linkedin's profile read, written after the run.
import { isHashed, normalizeLinkedinUrl } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { getCompanyDomain } from "@whytide/onboarding";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import { findOrganization, findWorkspace } from "@whytide/tenancy";
import { sourceKind } from "../../sources/registry.ts";
import { addCounts, type RunRef } from "../runs.ts";
import { profileKeys } from "./keys.ts";
import { dedupeKeyOf, ownCompanyRule } from "./rules.ts";

/** A candidate to read: its staging row's id and the profile's URL, which only its request file holds. */
export type Selected = { readonly id: string; readonly profileUrl: string };
type Drop = "dropped_company" | "dropped_own" | "dropped_hashed" | "dropped_known";

/** The own-employee rule's name, read outside any run: the organization's, else the workspace's. */
export async function ownCompanyName(workspaceId: string): Promise<string | null> {
  const workspace = await findWorkspace(workspaceId);
  if (workspace === null) return null;
  const organization = await findOrganization(workspace.organizationId);
  return organization?.name.trim() || workspace.name.trim() || null;
}

/** The run's candidates after the cheap drops, oldest staged first; none when the source is gone. */
export async function selectCandidates(
  { sourceId, runId }: RunRef,
  ownName: string | null,
): Promise<Selected[]> {
  const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
  if (source === null) return [];
  const { event } = sourceKind(source.kind);
  const objectUrl = event.objectOf(source.config);
  const own = ownCompanyRule({ domain: await getCompanyDomain(), name: ownName });
  const staged = await tenantClient.signalCandidate.findMany({
    where: { runId },
    orderBy: { id: "asc" },
  });
  const byUrl = await isHashed({ linkedinUrls: staged.map((c) => c.profileUrl) });
  const byId = await isHashed({ providerIds: staged.map((c) => c.providerMemberRef) });
  const keyOf = (c: (typeof staged)[number]) =>
    dedupeKeyOf({ kind: event.kind, actor: c.providerMemberRef, objectUrl, role: c.reaction });
  const known = await tenantClient.signalEvent.findMany({
    where: { dedupeKey: { in: staged.map(keyOf) } },
    select: { dedupeKey: true },
  });
  const knownKeys = new Set(known.map(({ dedupeKey }) => dedupeKey));
  const counts: Record<Drop, number> = {
    dropped_company: 0,
    dropped_own: 0,
    dropped_hashed: 0,
    dropped_known: 0,
  };
  const dropped: string[] = [];
  const selected: Selected[] = [];
  for (const candidate of staged) {
    const { id, profileUrl, headline, providerMemberRef } = candidate;
    let drop: Drop | null = null;
    if (normalizeLinkedinUrl(profileUrl) === null) drop = "dropped_company";
    else if (own(headline)) drop = "dropped_own";
    else if (byUrl.has(profileUrl) || byId.has(providerMemberRef)) drop = "dropped_hashed";
    else if (knownKeys.has(keyOf(candidate))) drop = "dropped_known";
    if (drop === null) selected.push({ id, profileUrl });
    else {
      counts[drop] += 1;
      dropped.push(id);
    }
  }
  await tenantClient.signalCandidate.deleteMany({ where: { id: { in: dropped } } });
  await addCounts(runId, counts);
  return selected;
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
