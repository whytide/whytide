-- CreateEnum
CREATE TYPE "approval_action_type" AS ENUM ('invite', 'message');

-- CreateEnum
CREATE TYPE "approval_item_status" AS ENUM ('pending', 'approved', 'skipped', 'blocked');

-- CreateEnum
CREATE TYPE "approval_decision_origin" AS ENUM ('app');

-- CreateTable
CREATE TABLE "approval_items" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "step_execution_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "sender_account_id" TEXT NOT NULL,
    "action_type" "approval_action_type" NOT NULL,
    "step_key" TEXT NOT NULL,
    "draft_id" TEXT,
    "scheduled_for" TIMESTAMPTZ NOT NULL,
    "status" "approval_item_status" NOT NULL DEFAULT 'pending',
    "approved_content_hash" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ,
    "decision_origin" "approval_decision_origin",
    "wait_code" TEXT,
    "wait_until" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "approval_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_items_workspace_id_status_scheduled_for_idx" ON "approval_items"("workspace_id", "status", "scheduled_for");

-- CreateIndex
CREATE INDEX "approval_items_workspace_id_person_id_idx" ON "approval_items"("workspace_id", "person_id");

-- Hand-written (prisma/schema/approvals.prisma points here). An item moves once, from `pending` to
-- `approved`, `skipped` or `blocked`: the frozen text's hash sits exactly on an approved item, the
-- decision's user, time and origin exactly on an approved or a skipped one, and the reason an
-- approved step waits on an approved one only.
ALTER TABLE "approval_items" ADD CONSTRAINT "approval_items_approved_hash" CHECK (("status" = 'approved') = ("approved_content_hash" IS NOT NULL)),
  ADD CONSTRAINT "approval_items_decision" CHECK (
    ("status" IN ('approved', 'skipped')) = ("decided_by" IS NOT NULL)
    AND ("status" IN ('approved', 'skipped')) = ("decided_at" IS NOT NULL)
    AND ("status" IN ('approved', 'skipped')) = ("decision_origin" IS NOT NULL)
  ),
  ADD CONSTRAINT "approval_items_wait" CHECK ("wait_code" IS NULL OR "status" = 'approved');

-- One pending item per step, and one approved item per step, which Prisma's schema cannot say
-- (partial keys): a second open answers the first, and a step is never approved twice.
CREATE UNIQUE INDEX "approval_items_pending_key" ON "approval_items"("workspace_id", "step_execution_id") WHERE "status" = 'pending';
CREATE UNIQUE INDEX "approval_items_approved_key" ON "approval_items"("workspace_id", "step_execution_id") WHERE "status" = 'approved';

-- Grants and policy as alpha's tenant tables have them: the owner's default privileges give app
-- SELECT, INSERT, UPDATE and DELETE (20261021000000_db_roles), which the decisions and the erasure
-- need; no row-level policy before zeta (docs/rules/security.md §3).
