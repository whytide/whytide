// The automatic draft (README "The automatic draft"): the body of the subscriber to onboarding's
// company_knowledge_updated (events.ts). In the delivery's tenant run, under the default audience's
// row lock, it requests a draft from the Company Knowledge alone, marked automatic, while the default
// has no targeting and no draft of it is running or waiting for review; its run then saves its own
// proposal (draft.ts recordDraft). The other audiences are never drafted automatically.
import { tenantClient } from "@whytide/db";
import { readCompanyKnowledge } from "@whytide/onboarding";
import { currentTenant } from "@whytide/platform";
import { getIcp, lockedIcpId } from "./commands.ts";
import { AUTO_DRAFT_HELD_BY, NO_BRIEF } from "./constants.ts";
import { sourcesOf, startDraft } from "./draft.ts";
import { hasTargeting } from "./rules.ts";

/**
 * Requests the automatic draft of the run's default audience, made on the first read, and answers
 * its run's id; null, nothing written, while the Company Knowledge has no content field (before the
 * default is read), the default has targeting, or a draft of it is drafting or drafted. The row lock
 * orders a burst of deliveries: the first requests, the others find it drafting.
 */
export async function draftAutomatically(): Promise<string | null> {
  const { workspaceId } = currentTenant();
  if (sourcesOf(await readCompanyKnowledge(workspaceId), NO_BRIEF) === null) return null;
  const id = await lockedIcpId();
  if (hasTargeting(await getIcp(workspaceId, id))) return null;
  const { draftStatus } = await tenantClient.icp.findFirstOrThrow({
    where: { id },
    select: { draftStatus: true },
  });
  if (AUTO_DRAFT_HELD_BY.includes(draftStatus)) return null;
  return startDraft(id, NO_BRIEF, true);
}
