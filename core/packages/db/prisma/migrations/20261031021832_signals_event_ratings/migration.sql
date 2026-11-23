-- AlterTable
ALTER TABLE "signal_events" ADD COLUMN     "decision_record_id" TEXT,
ADD COLUMN     "intent_class" TEXT,
ADD COLUMN     "rating_status" TEXT NOT NULL DEFAULT 'unrated',
ADD COLUMN     "relevance" DOUBLE PRECISION,
ADD COLUMN     "relevance_rationale" TEXT;

-- CreateIndex
CREATE INDEX "signal_events_workspace_id_source_id_rating_status_occurred_idx" ON "signal_events"("workspace_id", "source_id", "rating_status", "occurred_at");
