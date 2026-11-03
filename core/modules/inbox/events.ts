// The events this module publishes, written to the outbox in the transaction of the change
// (docs/rules/coding.md §2, §3): ids only, never a text. Its subscriber to linkedin.message_received
// starts inbox_store_message for each message the receiver kept (README.md "The store"); its own
// inbox.reply_received starts inbox_reply_mail for each reply stored (README.md "The reply mail");
// its subscriber to campaigns.step_sent stores a sent message step's message in its thread (README.md
// "The platform's own messages").
import { events as campaigns } from "@whytide/campaigns";
import { events as linkedin } from "@whytide/linkedin";
import { currentTenant, defineEvents, startWorkflow, subscribe } from "@whytide/platform";
import { z } from "zod";
import { MAIL_WORKFLOW } from "./domain/constants.ts";
import { ID_MAX, STORE_WORKFLOW } from "./domain/store/constants.ts";
import { storeSent } from "./domain/store/sent.ts";

const id = z.string().min(1).max(ID_MAX);

export const events = defineEvents({
  /** A reply stored for the first time, its person's steps held: ids only. */
  "inbox.reply_received": z.strictObject({ messageId: id, threadId: id, personId: id }),
});

// One run per event, by the event's id: a second delivery starts none (platform README "Workflows").
// The workspace is the delivery's tenant run, never the payload's; the text stays in the file.
subscribe(linkedin["linkedin.message_received"], async (message, { id: eventId }) => {
  const { workspaceId } = currentTenant();
  await startWorkflow({
    workflow: "inbox_store_message",
    input: {
      workspaceId,
      senderAccountId: message.sender_account_id,
      personId: message.person_id,
      direction: message.direction,
      fileKey: message.file_key,
    },
    workflowId: `${STORE_WORKFLOW}:${workspaceId}:${eventId}`,
  });
});

// One mail per reply, by the message's id: a second delivery starts none, and the sent marker stops
// a later run (domain/mail.ts). The mail goes from the workflow, never from this delivery's run.
subscribe(events["inbox.reply_received"], async (reply) => {
  const { workspaceId } = currentTenant();
  await startWorkflow({
    workflow: "inbox_reply_mail",
    input: { workspaceId, messageId: reply.messageId },
    workflowId: `${MAIL_WORKFLOW}:${workspaceId}:${reply.messageId}`,
  });
});

// The step's message, in the delivery's own run: rows only, no file and no provider, so a second
// delivery finds the row holding the step and changes nothing (domain/store/sent.ts).
subscribe(campaigns["campaigns.step_sent"], async (sent) => {
  await storeSent(sent, new Date());
});
