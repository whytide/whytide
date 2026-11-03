-- DropForeignKey
ALTER TABLE "signal_runs" DROP CONSTRAINT "signal_runs_source_id_fkey";

-- CreateTable
CREATE TABLE "signal_candidates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "provider_member_ref" TEXT NOT NULL,
    "profile_url" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "reaction" TEXT NOT NULL,
    "comment_text" TEXT,
    "engaged_at" TIMESTAMPTZ NOT NULL,
    "raw_ref" TEXT NOT NULL,

    CONSTRAINT "signal_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signal_candidates_workspace_id_run_id_provider_member_ref_r_key" ON "signal_candidates"("workspace_id", "run_id", "provider_member_ref", "reaction");

-- CreateIndex
CREATE UNIQUE INDEX "signal_sources_workspace_id_id_key" ON "signal_sources"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signal_runs_workspace_id_id_key" ON "signal_runs"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "signal_runs" ADD CONSTRAINT "signal_runs_workspace_id_source_id_fkey" FOREIGN KEY ("workspace_id", "source_id") REFERENCES "signal_sources"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_candidates" ADD CONSTRAINT "signal_candidates_workspace_id_run_id_fkey" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "signal_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

