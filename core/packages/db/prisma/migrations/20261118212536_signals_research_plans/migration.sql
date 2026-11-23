-- CreateTable
CREATE TABLE "signal_research_plans" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "words" JSONB NOT NULL,
    "place_ids" TEXT[],
    "refused" JSONB NOT NULL DEFAULT '{}',
    "decision_record_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_research_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_research_queries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "place_id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "asked_at" TIMESTAMPTZ,
    "result_count" INTEGER,

    CONSTRAINT "signal_research_queries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signal_research_plans_workspace_id_source_id_created_at_idx" ON "signal_research_plans"("workspace_id", "source_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "signal_research_plans_workspace_id_id_key" ON "signal_research_plans"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signal_research_plans_workspace_id_run_id_key" ON "signal_research_plans"("workspace_id", "run_id");

-- CreateIndex
CREATE INDEX "signal_research_queries_workspace_id_source_id_asked_at_idx" ON "signal_research_queries"("workspace_id", "source_id", "asked_at");

-- CreateIndex
CREATE UNIQUE INDEX "signal_research_queries_workspace_id_id_key" ON "signal_research_queries"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signal_research_queries_workspace_id_plan_id_position_key" ON "signal_research_queries"("workspace_id", "plan_id", "position");

-- AddForeignKey
ALTER TABLE "signal_research_plans" ADD CONSTRAINT "signal_research_plans_workspace_id_run_id_fkey" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "signal_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_research_queries" ADD CONSTRAINT "signal_research_queries_workspace_id_plan_id_fkey" FOREIGN KEY ("workspace_id", "plan_id") REFERENCES "signal_research_plans"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
