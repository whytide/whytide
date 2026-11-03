-- CreateEnum
CREATE TYPE "message_draft_kind" AS ENUM ('lead_draft', 'outbound_step');

-- AlterEnum
ALTER TYPE "message_draft_status" ADD VALUE 'approved';

-- AlterTable
ALTER TABLE "message_drafts" ADD COLUMN     "approved_at" TIMESTAMPTZ,
ADD COLUMN     "edit_ratio" DECIMAL(4,3),
ADD COLUMN     "edited_by_user" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kind" "message_draft_kind" NOT NULL DEFAULT 'lead_draft',
ADD COLUMN     "step_execution_id" TEXT,
ADD COLUMN     "step_key" TEXT;

-- Hand-written (prisma/schema/messaging.prisma points here): a step's draft names its step
-- execution and its step, a lead's draft neither; `approved_at` is set exactly when the draft is
-- `approved`, which only a step's draft ever is; an edit's ratio is a share. The status is compared
-- as text: Postgres refuses the value `approved` inside the transaction that adds it.
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_step_columns" CHECK (
    ("kind" = 'outbound_step') = ("step_execution_id" IS NOT NULL)
    AND ("kind" = 'outbound_step') = ("step_key" IS NOT NULL)
  ),
  ADD CONSTRAINT "message_drafts_approved_at" CHECK (("status"::text = 'approved') = ("approved_at" IS NOT NULL)),
  ADD CONSTRAINT "message_drafts_approved_step" CHECK ("status"::text <> 'approved' OR "kind" = 'outbound_step'),
  ADD CONSTRAINT "message_drafts_edit_ratio_share" CHECK ("edit_ratio" >= 0 AND "edit_ratio" <= 1);

-- Hand-written: one draft per step execution, which Prisma's schema cannot say (a partial key).
CREATE UNIQUE INDEX "message_drafts_workspace_id_step_execution_id_key" ON "message_drafts"("workspace_id", "step_execution_id") WHERE "step_execution_id" IS NOT NULL;
