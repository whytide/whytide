-- alpha-p6-040: a re-score from the stored verdicts writes a copy of the snapshot keyed with the
-- criteria it is scored with, hashed; the assessment's own snapshot keeps the empty hash.
ALTER TABLE "score_snapshots" ADD COLUMN "criteria_hash" TEXT NOT NULL DEFAULT '';

DROP INDEX "score_snapshots_workspace_id_decision_record_id_icp_version_key";

CREATE UNIQUE INDEX "score_snapshots_workspace_id_decision_record_id_icp_version_key" ON "score_snapshots"("workspace_id", "decision_record_id", "icp_version", "criteria_hash");
