-- CreateEnum
CREATE TYPE "sender_quota_reservation_status" AS ENUM ('reserved', 'committed', 'released', 'expired');

-- CreateEnum
CREATE TYPE "sender_action_kind" AS ENUM ('read_engagers', 'read_profile', 'status_check');

-- CreateTable
CREATE TABLE "sender_quota_usage" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "sender_account_id" TEXT NOT NULL,
    "quota_day" TEXT NOT NULL,
    "reads_reserved" INTEGER NOT NULL DEFAULT 0,
    "reads_committed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sender_quota_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sender_quota_reservations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "sender_account_id" TEXT NOT NULL,
    "usage_id" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "committed" INTEGER,
    "status" "sender_quota_reservation_status" NOT NULL DEFAULT 'reserved',
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,
    "settled_at" TIMESTAMPTZ,

    CONSTRAINT "sender_quota_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sender_action_log" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "sender_account_id" TEXT NOT NULL,
    "kind" "sender_action_kind" NOT NULL,
    "object_ref" TEXT,
    "count" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sender_action_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sender_quota_usage_workspace_id_sender_account_id_quota_day_key" ON "sender_quota_usage"("workspace_id", "sender_account_id", "quota_day");

-- CreateIndex
CREATE INDEX "sender_quota_reservations_workspace_id_usage_id_status_expi_idx" ON "sender_quota_reservations"("workspace_id", "usage_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "sender_action_log_workspace_id_sender_account_id_at_idx" ON "sender_action_log"("workspace_id", "sender_account_id", "at");

-- Hand-written (prisma/schema/linkedin.prisma points here): the quota day is a date as text, and no
-- count is negative, so no settlement can take a day's counters below zero.
ALTER TABLE "sender_quota_usage" ADD CONSTRAINT "sender_quota_usage_quota_day_date" CHECK ("quota_day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  ADD CONSTRAINT "sender_quota_usage_reads_non_negative" CHECK ("reads_reserved" >= 0 AND "reads_committed" >= 0);
ALTER TABLE "sender_quota_reservations" ADD CONSTRAINT "sender_quota_reservations_counts" CHECK ("count" > 0 AND ("committed" IS NULL OR "committed" >= 0));
ALTER TABLE "sender_action_log" ADD CONSTRAINT "sender_action_log_count_non_negative" CHECK ("count" >= 0);
