-- CreateEnum
CREATE TYPE "signal_run_status" AS ENUM ('scheduled', 'running', 'waiting', 'done', 'failed');

-- CreateTable
CREATE TABLE "signal_sources" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "label" TEXT NOT NULL,
    "sender_account_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_run_at" TIMESTAMPTZ,
    "watermark" JSONB,

    CONSTRAINT "signal_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "status" "signal_run_status" NOT NULL DEFAULT 'scheduled',
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,

    CONSTRAINT "signal_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signal_sources_workspace_id_enabled_idx" ON "signal_sources"("workspace_id", "enabled");

-- CreateIndex
CREATE INDEX "signal_runs_workspace_id_source_id_started_at_idx" ON "signal_runs"("workspace_id", "source_id", "started_at" DESC);

-- AddForeignKey
ALTER TABLE "signal_runs" ADD CONSTRAINT "signal_runs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "signal_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
