-- A research event has neither a reaction nor an author (gamma-wr-060): the evidence's two columns
-- become nullable. Expand only: no row changes, no column is dropped.
ALTER TABLE "evidence" ALTER COLUMN "reaction" DROP NOT NULL;
ALTER TABLE "evidence" ALTER COLUMN "author" DROP NOT NULL;

-- The found company a research event's person was taken from, a plain id with no key.
ALTER TABLE "signal_events" ADD COLUMN "found_company_id" TEXT;

-- When a found company's people were taken, once the look ran to its end.
ALTER TABLE "signal_found_companies" ADD COLUMN "people_taken_at" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "signal_events_workspace_id_found_company_id_idx" ON "signal_events"("workspace_id", "found_company_id");
