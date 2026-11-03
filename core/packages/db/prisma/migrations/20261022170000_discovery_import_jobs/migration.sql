-- CreateEnum
CREATE TYPE "import_job_status" AS ENUM ('uploaded', 'validated', 'invalid', 'running', 'done', 'failed');

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "status" "import_job_status" NOT NULL,
    "row_count" INTEGER NOT NULL,
    "valid_count" INTEGER NOT NULL,
    "error_count" INTEGER NOT NULL,
    "report" JSONB NOT NULL,
    "counts" JSONB,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_jobs_workspace_id_created_at_idx" ON "import_jobs"("workspace_id", "created_at");
