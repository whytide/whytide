-- alpha-p10-100: the hash of the criteria that scored a snapshot, outside the unique key, so that a
-- re-score with those criteria writes no copy of the assessment's own snapshot. A re-score's copy was
-- scored with the criteria its key names.
ALTER TABLE "score_snapshots" ADD COLUMN "scored_criteria_hash" TEXT NOT NULL DEFAULT '';

UPDATE "score_snapshots" SET "scored_criteria_hash" = "criteria_hash" WHERE "criteria_hash" <> '';

-- CreateTable
CREATE TABLE "assessment_attempts" (
    "workspace_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "icp_version" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL,

    CONSTRAINT "assessment_attempts_pkey" PRIMARY KEY ("workspace_id","person_id","icp_version")
);
