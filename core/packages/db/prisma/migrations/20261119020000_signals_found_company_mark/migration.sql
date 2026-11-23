-- AlterTable: who marked a found company Not a fit, and when (gamma-wr-110); expand only.
ALTER TABLE "signal_found_companies" ADD COLUMN "member_marked_by" TEXT,
ADD COLUMN "member_marked_at" TIMESTAMPTZ;
