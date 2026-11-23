// qualification.lead_hot (README "The Hot alert"): published in the run of the intent write that
// takes the lead into Hot (score/score-snapshot.ts), so that the outbox's row commits with the row.
// Ids only.
import { outboxWriter, tenantClient } from "@whytide/db";
import { currentTenant, publish } from "@whytide/platform";
import { events } from "../../events.ts";

/** The person's entry into Hot, in the caller's tenant run: the event's id. */
export async function publishLeadHot(personId: string): Promise<string> {
  const { workspaceId } = currentTenant();
  const outbox = outboxWriter(tenantClient, workspaceId);
  return publish(outbox, events["qualification.lead_hot"], { workspaceId, personId });
}
