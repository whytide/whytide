-- CreateTable
CREATE TABLE "grounding_samples" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "week" TEXT NOT NULL,
    "why_count" INTEGER NOT NULL,
    "draft_count" INTEGER NOT NULL,
    "invented_facts" INTEGER NOT NULL,
    "reviewed_by" TEXT NOT NULL,
    "reviewed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grounding_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "grounding_samples_workspace_id_week_key" ON "grounding_samples"("workspace_id", "week");
