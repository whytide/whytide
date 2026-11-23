-- CreateIndex
CREATE INDEX "enrollments_workspace_id_template_id_status_idx" ON "enrollments"("workspace_id", "template_id", "status");

-- CreateIndex
CREATE INDEX "enrollments_workspace_id_sender_account_id_ended_at_idx" ON "enrollments"("workspace_id", "sender_account_id", "ended_at");

-- CreateIndex
CREATE INDEX "step_executions_workspace_id_sender_account_id_executed_at_idx" ON "step_executions"("workspace_id", "sender_account_id", "executed_at");
