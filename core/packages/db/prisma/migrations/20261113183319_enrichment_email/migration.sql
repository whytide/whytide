-- CreateEnum
CREATE TYPE "contact_point_kind" AS ENUM ('work_email', 'personal_email');

-- CreateEnum
CREATE TYPE "email_verification" AS ENUM ('valid', 'catch_all', 'risky', 'invalid', 'unknown');

-- CreateEnum
CREATE TYPE "contact_point_status" AS ENUM ('active', 'bounced', 'opted_out');

-- CreateEnum
CREATE TYPE "email_lookup_trigger" AS ENUM ('jit_step', 'request', 'reverify');

-- CreateEnum
CREATE TYPE "enrichment_request_status" AS ENUM ('queued', 'running', 'found', 'not_found', 'failed', 'skipped_suppressed', 'waiting_budget', 'waiting_allowance');

-- CreateEnum
CREATE TYPE "enrichment_cache_kind" AS ENUM ('email', 'negative');

-- CreateTable
CREATE TABLE "contact_points" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "kind" "contact_point_kind" NOT NULL,
    "value" TEXT NOT NULL,
    "verification" "email_verification" NOT NULL,
    "verified_at" TIMESTAMPTZ NOT NULL,
    "confidence" TEXT,
    "source_class" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "acquired_at" TIMESTAMPTZ NOT NULL,
    "legal_basis" TEXT NOT NULL,
    "status" "contact_point_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrichment_requests" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "trigger" "email_lookup_trigger" NOT NULL,
    "request_key" TEXT NOT NULL,
    "status" "enrichment_request_status" NOT NULL DEFAULT 'queued',
    "reason" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "providers_tried" JSONB NOT NULL DEFAULT '[]',
    "contact_point_id" TEXT,
    "credit_usage_id" TEXT,
    "error_code" TEXT,
    "credits_charged" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "enrichment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrichment_cache_entries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "kind" "enrichment_cache_kind" NOT NULL,
    "value" TEXT,
    "verification" "email_verification",
    "reason" TEXT,
    "provider" TEXT NOT NULL,
    "retrieved_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "person_id" TEXT NOT NULL,

    CONSTRAINT "enrichment_cache_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_domain_statuses" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "catch_all" BOOLEAN NOT NULL,
    "provider" TEXT NOT NULL,
    "checked_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "email_domain_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_points_workspace_id_person_id_idx" ON "contact_points"("workspace_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_points_workspace_id_value_key" ON "contact_points"("workspace_id", "value");

-- CreateIndex
CREATE INDEX "enrichment_requests_workspace_id_person_id_created_at_idx" ON "enrichment_requests"("workspace_id", "person_id", "created_at");

-- CreateIndex
CREATE INDEX "enrichment_requests_workspace_id_status_created_at_idx" ON "enrichment_requests"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "enrichment_requests_workspace_id_request_key_key" ON "enrichment_requests"("workspace_id", "request_key");

-- CreateIndex
CREATE INDEX "enrichment_cache_entries_workspace_id_person_id_idx" ON "enrichment_cache_entries"("workspace_id", "person_id");

-- CreateIndex
CREATE INDEX "enrichment_cache_entries_workspace_id_expires_at_idx" ON "enrichment_cache_entries"("workspace_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "enrichment_cache_entries_workspace_id_kind_key_hash_key" ON "enrichment_cache_entries"("workspace_id", "kind", "key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "email_domain_statuses_domain_key" ON "email_domain_statuses"("domain");
