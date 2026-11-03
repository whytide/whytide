-- CreateEnum
CREATE TYPE "sender_health_state" AS ENUM ('healthy', 'at_risk', 'restricted', 'checkpoint', 'disconnected');

-- CreateEnum
CREATE TYPE "sender_health_trigger" AS ENUM ('acceptance_rate', 'rate_limit_errors', 'checkpoint', 'limit_reached', 'session_invalid', 'manual');

-- CreateEnum
CREATE TYPE "sender_health_action" AS ENUM ('paused_all_actions', 'paused_invites', 'resumed');

-- AlterTable
ALTER TABLE "sender_accounts" ADD COLUMN     "health_changed_at" TIMESTAMPTZ,
ADD COLUMN     "health_state" "sender_health_state" NOT NULL DEFAULT 'healthy',
ADD COLUMN     "paused_until" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "sender_health_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "sender_type" TEXT NOT NULL DEFAULT 'linkedin',
    "sender_id" TEXT NOT NULL,
    "from_state" "sender_health_state" NOT NULL,
    "to_state" "sender_health_state" NOT NULL,
    "trigger" "sender_health_trigger" NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "automatic_action" "sender_health_action",
    "paused_until" TIMESTAMPTZ,
    "ack_required" BOOLEAN NOT NULL DEFAULT false,
    "acknowledged_by" TEXT,
    "acknowledged_at" TIMESTAMPTZ,
    "owner_notified_at" TIMESTAMPTZ,
    "operator_notified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sender_health_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sender_health_events_workspace_id_sender_id_created_at_idx" ON "sender_health_events"("workspace_id", "sender_id", "created_at");

-- Hand-written (prisma/schema/linkedin.prisma points here). The cool-down's end is null outside
-- `restricted` and `checkpoint`, the states it belongs to.
ALTER TABLE "sender_accounts" ADD CONSTRAINT "sender_accounts_paused_until" CHECK ("paused_until" IS NULL OR "health_state" IN ('restricted', 'checkpoint'));

-- A health event is LinkedIn's until another sender exists.
ALTER TABLE "sender_health_events" ADD CONSTRAINT "sender_health_events_sender_type" CHECK ("sender_type" = 'linkedin');

-- The health events are kept for the account's history (docs/security.md): app reads, inserts and
-- updates them (the acknowledgement and the mails' markers), never deletes one. No person data, so
-- no eraser.
REVOKE DELETE ON TABLE "sender_health_events" FROM app;
