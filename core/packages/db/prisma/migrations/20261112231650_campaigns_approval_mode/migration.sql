-- CreateEnum
CREATE TYPE "campaign_approval_mode" AS ENUM ('review_everything', 'review_first_touches');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "approval_mode" "campaign_approval_mode" NOT NULL DEFAULT 'review_everything',
ADD COLUMN     "approval_mode_set_at" TIMESTAMPTZ,
ADD COLUMN     "approval_mode_set_by" TEXT,
ADD COLUMN     "review_locked_until" TIMESTAMPTZ NOT NULL DEFAULT (now() + '7 days'::interval);

-- Hand-written (prisma/schema/campaigns.prisma points here; gamma-p4-070). The default above stands
-- for the campaigns there now: each is locked in "Review everything" until 7 days from this
-- migration's time; campaigns' commands write a new campaign's lock from its creation.
--
-- Who last changed the mode and when, set together, or neither until a member changes it.
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_approval_mode_set" CHECK (
    ("approval_mode_set_by" IS NULL) = ("approval_mode_set_at" IS NULL)
  );
