-- The audience a lead's decision was judged against (gamma-p5-055; contacts' docs/data.md), beside
-- icp_version_scored. Expand only: a nullable column, no backfill, since null is a decision made
-- before audiences, which is the default audience's; the previous release never reads it.

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "icp_id_scored" TEXT;

-- CreateIndex
CREATE INDEX "leads_workspace_id_icp_id_scored_icp_version_scored_idx" ON "leads"("workspace_id", "icp_id_scored", "icp_version_scored");
