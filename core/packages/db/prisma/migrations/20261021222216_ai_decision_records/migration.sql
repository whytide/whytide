-- CreateEnum
CREATE TYPE "decision_status" AS ENUM ('ok', 'ai_failed');

-- CreateTable
CREATE TABLE "decision_records" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "subject_ref" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "prompt_version" INTEGER NOT NULL,
    "input_hash" TEXT NOT NULL,
    "status" "decision_status" NOT NULL,
    "output" JSONB,
    "gates" JSONB NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_credits" DECIMAL(65,30) NOT NULL,
    "attempts" INTEGER NOT NULL,
    "raw_prompt" TEXT,
    "raw_output" TEXT,
    "raw_purge_after" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "decision_records_workspace_id_task_subject_ref_input_hash_m_key" ON "decision_records"("workspace_id", "task", "subject_ref", "input_hash", "model_id", "prompt_version");
