// qualification.lead_qualified (README "The batch", "The re-score"): the lead's decision as stored,
// read after the write, published in the caller's tenant run that wrote it; none for a lead left
// pending. The batch's, the re-score's and a member's verdict's (member-verdict.ts).
import { getLead } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { currentTenant, publish } from "@whytide/platform";
import { events } from "../events.ts";

export async function publishDecision(personId: string): Promise<void> {
  const { qualificationStatus: status, tier } = await getLead(personId);
  if (status === "pending") return;
  const { workspaceId } = currentTenant();
  const payload = { workspaceId, personId, status, tier };
  const outbox = outboxWriter(tenantClient, workspaceId);
  await publish(outbox, events["qualification.lead_qualified"], payload);
}
