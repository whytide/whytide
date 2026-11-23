-- CreateEnum
CREATE TYPE "signal_research_candidate_state" AS ENUM ('pending', 'read', 'dropped');

-- CreateTable
CREATE TABLE "signal_research_candidates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "place" TEXT,
    "page_url" TEXT NOT NULL,
    "place_id" TEXT,
    "line" TEXT,
    "quote" TEXT,
    "state" "signal_research_candidate_state" NOT NULL DEFAULT 'pending',
    "drop_code" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "state_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_research_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signal_research_candidates_workspace_id_id_key" ON "signal_research_candidates"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signal_research_candidates_workspace_id_source_id_domain_key" ON "signal_research_candidates"("workspace_id", "source_id", "domain");

-- CreateIndex
CREATE INDEX "signal_research_candidates_workspace_id_source_id_state_cre_idx" ON "signal_research_candidates"("workspace_id", "source_id", "state", "created_at");

-- AddForeignKey
ALTER TABLE "signal_research_candidates" ADD CONSTRAINT "signal_research_candidates_workspace_id_source_id_fkey" FOREIGN KEY ("workspace_id", "source_id") REFERENCES "signal_sources"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
