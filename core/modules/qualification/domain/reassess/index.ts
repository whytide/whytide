// The leads decided by a rule title-check-ai retired (README "The batch"), which the batch assesses
// again once: those hard_filtered for a reason no filter gives anymore (the title), and those that a
// prompt before ICP_AWARE_PROMPT_VERSION made not_qualified for people-type disqualifiers only.
// contacts' selection reads them beside the pending leads, so a deploy in any order finds them.
import { PENDING_SNAPSHOTS_MAX } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { DISQUALIFIERS, type Disqualifier } from "../../schemas/assess-fit.ts";
import { RETIRED_HARD_FILTER_REASONS } from "../hard-filters/index.ts";
import { ICP_AWARE_PROMPT_VERSION, PEOPLE_TYPE_DISQUALIFIERS } from "./constants.ts";

/** What contacts' leadsPendingQualification takes beside the pending leads. */
export type RetiredDecisions = {
  readonly hardFilterReasons: string[];
  readonly currentSnapshotIds: string[];
};

const PEOPLE_TYPE: readonly Disqualifier[] = PEOPLE_TYPE_DISQUALIFIERS;
const OTHER_DISQUALIFIERS = DISQUALIFIERS.filter((code) => !PEOPLE_TYPE.includes(code));

/**
 * In the caller's tenant run: the retired hard-filter reasons, and the snapshots at `icpVersion` made
 * before ICP_AWARE_PROMPT_VERSION and scored not_qualified for people-type disqualifiers only, each
 * its person's newest at that version, oldest first, at most contacts' limit. A lead whose current
 * snapshot is one is assessed again once: the new assessment's snapshot is newer, so the old one
 * leaves the list.
 */
export async function retiredDecisions(icpVersion: number): Promise<RetiredDecisions> {
  const hardFilterReasons = [...RETIRED_HARD_FILTER_REASONS];
  const candidates = await tenantClient.scoreSnapshot.findMany({
    where: {
      icpVersion,
      promptVersion: { lt: ICP_AWARE_PROMPT_VERSION },
      status: "not_qualified",
      disqualifiers: { hasSome: [...PEOPLE_TYPE] },
      NOT: { disqualifiers: { hasSome: OTHER_DISQUALIFIERS } },
    },
    select: { id: true, personId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (candidates.length === 0) return { hardFilterReasons, currentSnapshotIds: [] };
  const personIds = [...new Set(candidates.map(({ personId }) => personId))];
  const newest = await tenantClient.scoreSnapshot.findMany({
    where: { icpVersion, personId: { in: personIds } },
    select: { id: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    distinct: ["personId"],
  });
  const latest = new Set(newest.map(({ id }) => id));
  const currentSnapshotIds = candidates
    .filter(({ id }) => latest.has(id))
    .slice(0, PENDING_SNAPSHOTS_MAX)
    .map(({ id }) => id);
  return { hardFilterReasons, currentSnapshotIds };
}
