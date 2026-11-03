-- CreateEnum
CREATE TYPE "lead_qualification_status" AS ENUM ('pending', 'hard_filtered', 'qualified', 'not_qualified', 'needs_review', 'ai_failed');

-- CreateEnum
CREATE TYPE "lead_source_kind" AS ENUM ('signal', 'imported');

-- CreateEnum
CREATE TYPE "lead_fit_confidence" AS ENUM ('high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "lead_tier" AS ENUM ('hot', 'warm', 'cool');

-- DropForeignKey: persons and leads link by the pair (workspace_id, id), so the database refuses a
-- link across workspaces (alpha-p5-020, while no real data exists).
ALTER TABLE "persons" DROP CONSTRAINT "persons_company_id_fkey";

-- CreateTable
CREATE TABLE "leads" (
    "person_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "qualification_status" "lead_qualification_status" NOT NULL DEFAULT 'pending',
    "source_label" "lead_source_kind" NOT NULL,
    "sources" JSONB NOT NULL,
    "first_source_at" TIMESTAMPTZ NOT NULL,
    "fit_score" INTEGER,
    "fit_confidence" "lead_fit_confidence",
    "tier" "lead_tier",
    "current_score_snapshot_id" TEXT,
    "why" JSONB NOT NULL DEFAULT '[]',
    "hard_filter_reason" TEXT,
    "status_reason" TEXT,
    "icp_version_scored" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("person_id")
);

-- CreateIndex
CREATE INDEX "leads_workspace_id_qualification_status_fit_score_idx" ON "leads"("workspace_id", "qualification_status", "fit_score");

-- CreateIndex
CREATE INDEX "leads_workspace_id_created_at_idx" ON "leads"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "leads_workspace_id_person_id_key" ON "leads"("workspace_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "persons_workspace_id_id_key" ON "persons"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_companies_workspace_id_id_key" ON "workspace_companies"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "persons" ADD CONSTRAINT "persons_workspace_id_company_id_fkey" FOREIGN KEY ("workspace_id", "company_id") REFERENCES "workspace_companies"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_workspace_id_person_id_fkey" FOREIGN KEY ("workspace_id", "person_id") REFERENCES "persons"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
