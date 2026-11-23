-- DropIndex
DROP INDEX "signal_candidates_workspace_id_run_id_provider_member_ref_r_key";

-- AlterTable
ALTER TABLE "evidence" ADD COLUMN     "post_excerpt" TEXT;

-- AlterTable
ALTER TABLE "signal_candidates" ADD COLUMN     "object_url" TEXT,
ADD COLUMN     "post_excerpt" TEXT;

-- CreateIndex
CREATE INDEX "evidence_workspace_id_url_idx" ON "evidence"("workspace_id", "url");

-- CreateIndex
CREATE UNIQUE INDEX "signal_candidates_workspace_id_run_id_provider_member_ref_r_key" ON "signal_candidates"("workspace_id", "run_id", "provider_member_ref", "reaction", "object_url");
