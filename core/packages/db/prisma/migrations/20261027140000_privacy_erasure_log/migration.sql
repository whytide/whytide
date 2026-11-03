-- CreateTable
CREATE TABLE "erasure_log" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "person_hash" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ NOT NULL,
    "counts" JSONB NOT NULL,
    "performed_by" TEXT NOT NULL,

    CONSTRAINT "erasure_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "erasure_log_workspace_id_completed_at_idx" ON "erasure_log"("workspace_id", "completed_at");

-- Append-only (privacy's docs/data.md): app writes and reads the log, and never changes or removes a row.
REVOKE UPDATE, DELETE ON TABLE "erasure_log" FROM app;
