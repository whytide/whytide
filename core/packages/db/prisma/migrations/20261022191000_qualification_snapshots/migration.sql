-- CreateEnum
CREATE TYPE "score_snapshot_status" AS ENUM ('assessed', 'qualified', 'not_qualified', 'needs_review');

-- CreateEnum
CREATE TYPE "score_confidence" AS ENUM ('high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "score_tier" AS ENUM ('hot', 'warm', 'cool');

-- CreateEnum
CREATE TYPE "qualification_criterion" AS ENUM ('title_function', 'seniority', 'company_size', 'industry', 'location', 'must_haves');

-- CreateEnum
CREATE TYPE "qualification_verdict" AS ENUM ('met', 'partially_met', 'not_met', 'unknown');

-- CreateEnum
CREATE TYPE "qualification_disqualifier" AS ENUM ('competitor', 'agency_or_consultant', 'freelancer', 'student_or_intern', 'job_seeker', 'recruiter', 'wrong_business_model', 'own_company', 'existing_customer', 'left_company', 'fake_or_inactive_profile');

-- CreateTable
CREATE TABLE "score_snapshots" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "icp_version" INTEGER NOT NULL,
    "model_id" TEXT NOT NULL,
    "prompt_version" INTEGER NOT NULL,
    "scorer_version" TEXT,
    "fit_score" INTEGER,
    "confidence" "score_confidence",
    "tier" "score_tier",
    "status" "score_snapshot_status" NOT NULL DEFAULT 'assessed',
    "disqualifiers" "qualification_disqualifier"[],
    "summary" TEXT NOT NULL,
    "decision_record_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "score_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "criterion_verdicts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "criterion" "qualification_criterion" NOT NULL,
    "verdict" "qualification_verdict" NOT NULL,
    "evidence" TEXT NOT NULL,
    "weight" INTEGER,
    "points" DECIMAL(5,2),

    CONSTRAINT "criterion_verdicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "score_snapshots_workspace_id_person_id_created_at_idx" ON "score_snapshots"("workspace_id", "person_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "score_snapshots_workspace_id_id_key" ON "score_snapshots"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "score_snapshots_workspace_id_decision_record_id_icp_version_key" ON "score_snapshots"("workspace_id", "decision_record_id", "icp_version");

-- CreateIndex
CREATE UNIQUE INDEX "criterion_verdicts_workspace_id_snapshot_id_criterion_key" ON "criterion_verdicts"("workspace_id", "snapshot_id", "criterion");

-- AddForeignKey
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_workspace_id_snapshot_id_fkey" FOREIGN KEY ("workspace_id", "snapshot_id") REFERENCES "score_snapshots"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
