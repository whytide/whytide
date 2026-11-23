// What a pause stops (README.md "Pausing"), read by the queue, the plan and the gate on every run,
// in the caller's tenant run, with no cache: a step of an enrollment `paused`, or of one whose
// campaign is not `active` (a draft, or paused), waits. The seeded campaign is active before its
// row exists, as beta's template stands for its version 1 (../campaigns/reads.ts); any other
// campaign the workspace does not have is not, so the check fails closed.
import { tenantClient } from "@whytide/db";
import { SEEDED_CAMPAIGN_KEY } from "../campaigns/constants.ts";
import type { PauseCode } from "../steps/constants.ts";

/** The campaign's status by its key_ref, as enrollments carry it; null for none. */
export async function campaignStatusOf(keyRef: string): Promise<string | null> {
  const campaign = await tenantClient.campaign.findFirst({
    where: { keyRef },
    select: { status: true },
  });
  return campaign?.status ?? (keyRef === SEEDED_CAMPAIGN_KEY ? "active" : null);
}

/** Of the enrollments, those whose steps wait, by id, with why; an enrollment absent goes on. */
export async function pausesOf(enrollmentIds: readonly string[]): Promise<Map<string, PauseCode>> {
  const ids = [...new Set(enrollmentIds)];
  if (ids.length === 0) return new Map();
  const enrollments = await tenantClient.enrollment.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, templateId: true },
  });
  // The campaigns in a query of their own: the tenant client refuses a relation in a query.
  const keys = [...new Set(enrollments.map(({ templateId }) => templateId))];
  const campaigns = await tenantClient.campaign.findMany({
    where: { keyRef: { in: keys } },
    select: { keyRef: true, status: true },
  });
  const status = new Map(campaigns.map(({ keyRef, status }) => [keyRef, status]));
  const waiting = new Map<string, PauseCode>();
  for (const { id, status: enrollment, templateId } of enrollments) {
    const campaign =
      status.get(templateId) ?? (templateId === SEEDED_CAMPAIGN_KEY ? "active" : null);
    if (enrollment === "paused") waiting.set(id, "enrollment_paused");
    else if (campaign !== "active") waiting.set(id, "campaign_not_active");
  }
  return waiting;
}
