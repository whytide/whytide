-- CreateEnum
CREATE TYPE "campaign_status" AS ENUM ('draft', 'active', 'paused', 'completed', 'archived');

-- CreateEnum
CREATE TYPE "campaign_change_kind" AS ENUM ('initial', 'structural');

-- CreateEnum
CREATE TYPE "step_channel" AS ENUM ('linkedin', 'email');

-- AlterTable
ALTER TABLE "step_executions" ADD COLUMN     "mailbox_id" TEXT,
ALTER COLUMN "sender_account_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "key_ref" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "campaign_status" NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "current_version_id" TEXT,
    "launched_at" TIMESTAMPTZ,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_versions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "change_kind" "campaign_change_kind" NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "steps" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_version_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "step_key" TEXT NOT NULL,
    "action_type" "step_action_type" NOT NULL,
    "channel" "step_channel" NOT NULL,
    "delay" JSONB NOT NULL,
    "step_template_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_workspace_id_status_idx" ON "campaigns"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "campaigns_workspace_id_owner_user_id_idx" ON "campaigns"("workspace_id", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_workspace_id_id_key" ON "campaigns"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_workspace_id_key_ref_key" ON "campaigns"("workspace_id", "key_ref");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_versions_workspace_id_id_key" ON "campaign_versions"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_versions_workspace_id_campaign_id_version_no_key" ON "campaign_versions"("workspace_id", "campaign_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "steps_workspace_id_campaign_version_id_position_key" ON "steps"("workspace_id", "campaign_version_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "steps_workspace_id_campaign_version_id_step_key_key" ON "steps"("workspace_id", "campaign_version_id", "step_key");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_current_version_id_fkey" FOREIGN KEY ("workspace_id", "current_version_id") REFERENCES "campaign_versions"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "campaign_versions" ADD CONSTRAINT "campaign_versions_workspace_id_campaign_id_fkey" FOREIGN KEY ("workspace_id", "campaign_id") REFERENCES "campaigns"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "steps" ADD CONSTRAINT "steps_workspace_id_campaign_version_id_fkey" FOREIGN KEY ("workspace_id", "campaign_version_id") REFERENCES "campaign_versions"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (campaigns' docs/data.md). Who acts on a step: a LinkedIn step has its sender
-- account and no mailbox, an email step a mailbox (gamma-p4-010 sets it) and no sender account.
-- Beta's rows are LinkedIn steps with their account, so the check holds for them as written.
ALTER TABLE "step_executions" ADD CONSTRAINT "step_executions_channel_actor" CHECK (
  ("sender_account_id" IS NULL) = ("action_type" = 'email')
  AND ("mailbox_id" IS NULL OR "action_type" = 'email')
);

-- A version never changes once saved: app reads and inserts versions and their steps, and never
-- updates or deletes one. No person data, so no eraser needs them.
REVOKE UPDATE, DELETE ON TABLE "campaign_versions", "steps" FROM app;
