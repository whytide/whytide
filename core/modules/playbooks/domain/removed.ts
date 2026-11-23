// A removed member's agents (gamma-p6-075; README "A removed member", docs/flows.md "A removed
// member"): tenancy.member_removed, delivered in a tenant run of the event's workspace (events.ts),
// pauses each of the user's agents there that is not archived, with the reason member_removed, in
// the delivery's transaction, and publishes playbooks.playbook_updated once per agent it changed. An
// agent its owner paused takes the new reason; one paused for the removal already and an archived
// one stay as they are, so a redelivery writes and publishes nothing. Only the owner, a member
// again, resumes it (updatePlaybook). No log line: the event carries ids and a status only.
import { outboxWriter, tenantClient } from "@whytide/db";
import { currentTenant, publish } from "@whytide/platform";
import { events } from "../events.ts";
import { MOVABLE_TO_REMOVED, PAUSED_FOR_REMOVAL } from "./constants.ts";

/** The user's agents in the run's workspace paused for their removal: how many moved. */
export async function pauseRemovedMember(userId: string): Promise<number> {
  // Prisma drops an undefined value from a where: unchecked, that would be every agent.
  if (typeof userId !== "string" || userId === "") return 0;
  const movable = { ownerUserId: userId, OR: [...MOVABLE_TO_REMOVED] };
  const agents = await tenantClient.playbook.findMany({
    where: movable,
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const outbox = outboxWriter(tenantClient, currentTenant().workspaceId);
  let moved = 0;
  for (const { id } of agents) {
    // Conditioned on the row as its lock finds it: an agent archived meanwhile, or moved by a
    // delivery of the same event at once, is left as it is, with no second event.
    const { count } = await tenantClient.playbook.updateMany({
      where: { id, ...movable },
      data: PAUSED_FOR_REMOVAL,
    });
    if (count === 0) continue;
    await publish(outbox, events["playbooks.playbook_updated"], {
      playbookId: id,
      status: PAUSED_FOR_REMOVAL.status,
    });
    moved += 1;
  }
  return moved;
}
