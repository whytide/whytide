-- The role words a research plan writes by language, for the search of a company's managers
-- (gamma-wr-090), kept with the plan as its words are: `[{ language, words }]`. Expand only: a plan
-- made before has none, its default, and no row changes.
ALTER TABLE "signal_research_plans" ADD COLUMN "role_words" JSONB NOT NULL DEFAULT '[]';
