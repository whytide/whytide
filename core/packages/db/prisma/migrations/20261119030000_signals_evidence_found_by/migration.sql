-- How a research event's person was found, when not as a page printed them (gamma-wr-070): `search`,
-- a LinkedIn profile found by one web search. Expand only: no row changes, nothing is dropped.
ALTER TABLE "evidence" ADD COLUMN "found_by" TEXT;
