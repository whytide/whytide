-- CreateEnum
CREATE TYPE "enrollment_status" AS ENUM ('active', 'replied', 'completed', 'exited');

-- CreateEnum
CREATE TYPE "enrollment_exit_reason" AS ENUM ('suppressed', 'removed', 'no_sender', 'not_accepted', 'send_refused');

-- CreateEnum
CREATE TYPE "step_action_type" AS ENUM ('invite', 'message', 'withdraw');

-- CreateEnum
CREATE TYPE "step_execution_status" AS ENUM ('planned', 'awaiting_approval', 'scheduled', 'executing', 'succeeded', 'failed', 'skipped', 'held', 'cancelled');

-- CreateTable
CREATE TABLE "enrollments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "sender_account_id" TEXT,
    "template_id" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL,
    "status" "enrollment_status" NOT NULL,
    "exit_reason" "enrollment_exit_reason",
    "exit_detail" TEXT,
    "source_event_id" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ,
    "ended_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "step_executions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "enrollment_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "sender_account_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL,
    "step_key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "action_type" "step_action_type" NOT NULL,
    "step_template_hash" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "step_execution_status" NOT NULL DEFAULT 'planned',
    "due_at" TIMESTAMPTZ,
    "scheduled_for" TIMESTAMPTZ,
    "quota_day" TEXT,
    "executed_at" TIMESTAMPTZ,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "jit_checks" JSONB,
    "skip_reason" TEXT,
    "error_code" TEXT,
    "approval_item_id" TEXT,
    "draft_id" TEXT,
    "credit_usage_id" TEXT,
    "accepted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "step_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enrollments_workspace_id_person_id_idx" ON "enrollments"("workspace_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_workspace_id_id_key" ON "enrollments"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_workspace_id_source_event_id_key" ON "enrollments"("workspace_id", "source_event_id");

-- CreateIndex
CREATE INDEX "step_executions_workspace_id_sender_account_id_status_sched_idx" ON "step_executions"("workspace_id", "sender_account_id", "status", "scheduled_for");

-- CreateIndex
CREATE INDEX "step_executions_workspace_id_person_id_idx" ON "step_executions"("workspace_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "step_executions_workspace_id_enrollment_id_step_key_key" ON "step_executions"("workspace_id", "enrollment_id", "step_key");

-- AddForeignKey
ALTER TABLE "step_executions" ADD CONSTRAINT "step_executions_workspace_id_enrollment_id_fkey" FOREIGN KEY ("workspace_id", "enrollment_id") REFERENCES "enrollments"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (prisma/schema/campaigns.prisma points here): what Prisma cannot say. One active
-- enrollment per person: a second delivery, or a second approval, enrolls no one again (campaigns'
-- docs/data.md).
CREATE UNIQUE INDEX "enrollments_active_person" ON "enrollments"("workspace_id", "person_id") WHERE "status" = 'active';

-- A key is claimed once: an unsent row never blocks another, but no second row with the key enters
-- executing while one is executing or has succeeded, so the same step content never reaches the
-- person twice. This departs from the data model's full unique key (campaigns' README "Decided here").
CREATE UNIQUE INDEX "step_executions_key_claimed" ON "step_executions"("workspace_id", "idempotency_key") WHERE "status" IN ('executing', 'succeeded');

-- An exit reason exactly on an exited enrollment; an end exactly on an enrollment no longer active.
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_exit_reason" CHECK (("exit_reason" IS NOT NULL) = ("status" = 'exited'));
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_ended_at" CHECK (("ended_at" IS NOT NULL) = ("status" <> 'active'));

-- A quota day is a date's text, as linkedin's (20261022191500_linkedin_quota_and_log); null until set.
ALTER TABLE "step_executions" ADD CONSTRAINT "step_executions_quota_day_date" CHECK ("quota_day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');

-- Grants and policy as alpha's tenant tables (20261022150500_contacts_initial): the owner's default
-- privileges give app SELECT, INSERT, UPDATE and DELETE (20261021000000_db_roles), which the sender
-- and erasure need; no row-level policy before zeta (docs/rules/security.md §3).
