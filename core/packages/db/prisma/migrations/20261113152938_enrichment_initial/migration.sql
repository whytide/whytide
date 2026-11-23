-- CreateEnum
CREATE TYPE "enrichment_trigger" AS ENUM ('new_lead', 'request');

-- CreateEnum
CREATE TYPE "enrichment_run_status" AS ENUM ('queued', 'running', 'done', 'failed');

-- CreateEnum
CREATE TYPE "source_usage_period" AS ENUM ('day', 'month');

-- CreateTable
CREATE TABLE "enrichment_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "company_id" TEXT,
    "trigger" "enrichment_trigger" NOT NULL,
    "request_key" TEXT NOT NULL,
    "status" "enrichment_run_status" NOT NULL DEFAULT 'queued',
    "skip_reason" TEXT,
    "wanted" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "filled" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sources_tried" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "enrichment_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_usage" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "period_start" TEXT NOT NULL,
    "period" "source_usage_period" NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "spent" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enrichment_runs_workspace_id_person_id_created_at_idx" ON "enrichment_runs"("workspace_id", "person_id", "created_at");

-- CreateIndex
CREATE INDEX "enrichment_runs_workspace_id_company_id_finished_at_idx" ON "enrichment_runs"("workspace_id", "company_id", "finished_at");

-- CreateIndex
CREATE UNIQUE INDEX "enrichment_runs_workspace_id_request_key_key" ON "enrichment_runs"("workspace_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "source_usage_source_period_start_key" ON "source_usage"("source", "period_start");

-- Hand-written (prisma/schema/enrichment.prisma points here; gamma-en-050): the instance's counters
-- of the sources' calls, which the app reads, inserts and updates and never deletes; a count is
-- never below 0.
REVOKE DELETE ON TABLE "source_usage" FROM app;
ALTER TABLE "source_usage" ADD CONSTRAINT "source_usage_used" CHECK ("used" >= 0);
