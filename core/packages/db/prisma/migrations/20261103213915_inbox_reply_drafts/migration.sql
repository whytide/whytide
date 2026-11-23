-- CreateEnum
CREATE TYPE "reply_draft_status" AS ENUM ('drafting', 'ready', 'failed');

-- CreateTable
CREATE TABLE "reply_drafts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "status" "reply_draft_status" NOT NULL DEFAULT 'drafting',
    "brief" TEXT,
    "text" TEXT,
    "replaced_text" TEXT,
    "error_code" TEXT,
    "model_id" TEXT,
    "prompt_version" INTEGER,
    "decision_record_id" TEXT,
    "requested_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "reply_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reply_drafts_workspace_id_status_requested_at_idx" ON "reply_drafts"("workspace_id", "status", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "reply_drafts_workspace_id_id_key" ON "reply_drafts"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reply_drafts_workspace_id_thread_id_key" ON "reply_drafts"("workspace_id", "thread_id");

-- AddForeignKey
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_workspace_id_thread_id_fkey" FOREIGN KEY ("workspace_id", "thread_id") REFERENCES "threads"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written (schema/inbox.prisma's header): a draft holds its text exactly when ready, and its
-- code exactly when failed; a drafting one holds neither.
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_status" CHECK (
  ("text" IS NOT NULL) = ("status" = 'ready')
  AND ("error_code" IS NOT NULL) = ("status" = 'failed')
);
