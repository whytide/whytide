-- AlterTable
ALTER TABLE "sender_outreach" ADD COLUMN     "last_message_ref" TEXT,
ADD COLUMN     "last_step_execution_id" TEXT;

-- CreateIndex
CREATE INDEX "sender_outreach_workspace_id_last_step_execution_id_idx" ON "sender_outreach"("workspace_id", "last_step_execution_id");
