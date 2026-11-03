-- AlterTable
ALTER TABLE "signal_runs" ADD COLUMN     "workflow_id" TEXT,
ADD COLUMN     "stop_requested_at" TIMESTAMPTZ;
