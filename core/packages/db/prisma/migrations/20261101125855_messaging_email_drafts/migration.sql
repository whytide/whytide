-- AlterTable
ALTER TABLE "message_drafts" ADD COLUMN     "edited_subject" TEXT,
ADD COLUMN     "mailbox_id" TEXT,
ADD COLUMN     "step_kind" TEXT,
ADD COLUMN     "subject" TEXT;

-- Hand-written (prisma/schema/messaging.prisma points here; gamma-p3-070): a subject, its edit and a
-- mailbox only on an email draft, a mailbox only on a sequence step's; the kind a lead's draft is
-- written as only on a lead's draft, one of WRITTEN_STEP_KINDS (core/modules/messaging
-- domain/drafts/constants.ts). The channel is compared as text, as beta's CHECKs compare the status.
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_email_columns" CHECK (
    ("channel"::text = 'email' OR ("subject" IS NULL AND "edited_subject" IS NULL AND "mailbox_id" IS NULL))
    AND ("mailbox_id" IS NULL OR "kind" = 'outbound_step')
  ),
  ADD CONSTRAINT "message_drafts_step_kind" CHECK (
    "step_kind" IS NULL
    OR ("kind" = 'lead_draft' AND "step_kind" IN ('first_message', 'follow_up', 'email_first', 'email_follow_up'))
  );

-- Hand-written: a mailbox's drafts of the last day, which the near-duplicate gate reads; a partial
-- index, which Prisma's schema cannot say.
CREATE INDEX "message_drafts_workspace_id_mailbox_id_created_at_idx" ON "message_drafts"("workspace_id", "mailbox_id", "created_at") WHERE "mailbox_id" IS NOT NULL;
