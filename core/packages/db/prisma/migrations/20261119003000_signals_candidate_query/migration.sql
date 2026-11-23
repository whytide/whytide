-- The query whose results led to a candidate's page (gamma-wr-051): a plain id, so that the plan can
-- count the companies each query led to. Null for a start page and for a candidate made before.
ALTER TABLE "signal_research_candidates" ADD COLUMN "query_id" TEXT;
