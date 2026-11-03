-- CreateEnum
CREATE TYPE "sender_account_status" AS ENUM ('pending', 'connected', 'credentials_required', 'error', 'disconnected');

-- CreateTable
CREATE TABLE "sender_accounts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_ref" BYTEA,
    "provider_account_ref_hash" TEXT,
    "provider_link_ref" TEXT,
    "status" "sender_account_status" NOT NULL DEFAULT 'pending',
    "status_checked_at" TIMESTAMPTZ,
    "time_zone" TEXT NOT NULL,
    "working_hours" JSONB NOT NULL,
    "daily_read_cap" INTEGER NOT NULL DEFAULT 100,
    "disclosure_acknowledged_at" TIMESTAMPTZ NOT NULL,
    "connected_at" TIMESTAMPTZ,
    "disconnected_at" TIMESTAMPTZ,

    CONSTRAINT "sender_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sender_accounts_provider_account_ref_hash_idx" ON "sender_accounts"("provider_account_ref_hash");

-- CreateIndex
CREATE INDEX "sender_accounts_provider_link_ref_idx" ON "sender_accounts"("provider_link_ref");

-- CreateIndex
CREATE UNIQUE INDEX "sender_accounts_workspace_id_owner_user_id_key" ON "sender_accounts"("workspace_id", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sender_accounts_workspace_id_provider_account_ref_hash_key" ON "sender_accounts"("workspace_id", "provider_account_ref_hash");
