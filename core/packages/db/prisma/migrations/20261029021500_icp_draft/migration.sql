-- AlterTable
ALTER TABLE "icps" ADD COLUMN     "draft_brief" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "draft_error" TEXT,
ADD COLUMN     "draft_run_id" TEXT,
ADD COLUMN     "draft_status" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "pending_draft" JSONB;
