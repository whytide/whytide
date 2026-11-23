// The events this module publishes, written to the outbox in the transaction of the change
// (docs/rules/coding.md §2, §3): ids only. Its own subscriber starts the revoke after a disconnect by
// the member or for a removed member, one run per disconnect, by its time: a second delivery starts
// none, and a mailbox reconnected since starts none (README.md "Worker").
import { tenantClient } from "@whytide/db";
import { currentTenant, defineEvents, startWorkflow, subscribe } from "@whytide/platform";
import { z } from "zod";

export const events = defineEvents({
  "email.mailbox_connected": z.strictObject({ mailbox_id: z.string() }),
  "email.mailbox_disconnected": z.strictObject({
    mailbox_id: z.string(),
    reason: z.enum(["user", "token_revoked", "member_removed"]),
  }),
});

subscribe(events["email.mailbox_disconnected"], async ({ mailbox_id, reason }) => {
  if (reason === "token_revoked") return; // the tokens are nulled already; nothing to revoke
  const { workspaceId } = currentTenant();
  const row = await tenantClient.mailbox.findFirst({
    where: { id: mailbox_id, status: "disconnected" },
    select: { disconnectedAt: true },
  });
  if (!row?.disconnectedAt) return; // reconnected since
  const disconnectedAt = row.disconnectedAt.toISOString();
  await startWorkflow({
    workflow: "email_revoke_mailbox",
    input: { workspaceId, mailboxId: mailbox_id, disconnectedAt },
    workflowId: `email.revoke:${workspaceId}:${mailbox_id}:${disconnectedAt}`,
  });
});
