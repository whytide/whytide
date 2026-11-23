// The events this module publishes, written to the outbox in the transaction of the change
// (docs/rules/coding.md §2, §3): ids only, never a text. Its subscriber to linkedin.message_received
// starts inbox_store_message for each message the receiver kept (README.md "The store"); its own
// inbox.reply_received starts inbox_reply_mail for each reply stored (README.md "The reply mail");
// its subscriber to campaigns.step_sent stores a sent message step's message in its thread (README.md
// "The platform's own messages"); its own inbox.reply_requested starts inbox_send_reply for each
// member's reply from the inbox (README.md "Replies from the inbox"); its own
// inbox.reply_draft_requested starts inbox_draft_reply for each reply draft (README.md "The reply
// draft"); inbox.reply_received starts inbox_classify_reply too, which publishes
// inbox.reply_classified (README.md "The classifier").
import { events as campaigns, REPLY_ACTION_LABELS } from "@whytide/campaigns";
import { events as linkedin } from "@whytide/linkedin";
import { currentTenant, defineEvents, startWorkflow, subscribe } from "@whytide/platform";
import { z } from "zod";
import { CLASSIFY_WORKFLOW } from "./domain/classify/constants.ts";
import { MAIL_WORKFLOW } from "./domain/constants.ts";
import { REPLY_WORKFLOW } from "./domain/reply/constants.ts";
import { REPLY_DRAFT_WORKFLOW } from "./domain/reply-draft/constants.ts";
import { ID_MAX, STORE_WORKFLOW } from "./domain/store/constants.ts";
import { storeSent } from "./domain/store/sent.ts";

const id = z.string().min(1).max(ID_MAX);

export const events = defineEvents({
  /** A reply stored for the first time, its person's steps held: ids only. */
  "inbox.reply_received": z.strictObject({ messageId: id, threadId: id, personId: id }),
  /** A member's reply from the inbox, its row `sending`: its message's id only. */
  "inbox.reply_requested": z.strictObject({ messageId: id }),
  /** A member's request of a reply draft, its row `drafting`: its id only, never the brief. */
  "inbox.reply_draft_requested": z.strictObject({ draftId: id }),
  /** A reply classified, its row written and campaigns' action taken: ids and the label only. */
  "inbox.reply_classified": z.strictObject({
    classificationId: id,
    messageId: id,
    threadId: id,
    personId: id,
    label: z.enum(REPLY_ACTION_LABELS),
  }),
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

// One classification per reply, by the message's id: a second delivery starts none, and a row
// already written ends a later run (domain/classify/write.ts). The model is called from the
// workflow, after the store's run committed the stop, never from this delivery's run.
subscribe(events["inbox.reply_received"], async (reply) => {
  const { workspaceId } = currentTenant();
  await startWorkflow({
    workflow: "inbox_classify_reply",
    input: { workspaceId, ...reply },
    workflowId: `${CLASSIFY_WORKFLOW}:${workspaceId}:${reply.messageId}`,
  });
});

// One send per reply, by the message's id: a second delivery starts none, and a row no longer
// `sending` sends nothing (domain/reply/begin.ts). The text stays in the row until the request file.
subscribe(events["inbox.reply_requested"], async (reply) => {
  const { workspaceId } = currentTenant();
  await startWorkflow({
    workflow: "inbox_send_reply",
    input: { workspaceId, messageId: reply.messageId },
    workflowId: `${REPLY_WORKFLOW}:${workspaceId}:${reply.messageId}`,
  });
});

// One writer's run per draft, by the draft's id: a second delivery starts none, and a draft no longer
// `drafting` is written by none (domain/reply-draft/write.ts). The brief stays in the row.
subscribe(events["inbox.reply_draft_requested"], async (draft) => {
  const { workspaceId } = currentTenant();
  await startWorkflow({
    workflow: "inbox_draft_reply",
    input: { workspaceId, draftId: draft.draftId },
    workflowId: `${REPLY_DRAFT_WORKFLOW}:${workspaceId}:${draft.draftId}`,
  });
});

// The step's message, in the delivery's own run: rows only, no file and no provider, so a second
// delivery finds the row holding the step and changes nothing (domain/store/sent.ts).
subscribe(campaigns["campaigns.step_sent"], async (sent) => {
  await storeSent(sent, new Date());
});
