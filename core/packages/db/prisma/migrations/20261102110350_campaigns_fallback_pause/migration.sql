-- CreateEnum
CREATE TYPE "enrollment_pause_reason" AS ENUM ('user', 'out_of_office');

-- CreateEnum
CREATE TYPE "campaign_pause_reason" AS ENUM ('user', 'bounce_rate');

-- CreateEnum
CREATE TYPE "step_condition" AS ENUM ('invite_not_accepted_within');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "paused_at" TIMESTAMPTZ,
ADD COLUMN     "paused_reason" "campaign_pause_reason";

-- AlterTable
ALTER TABLE "enrollments" ADD COLUMN     "paused_reason" "enrollment_pause_reason",
ADD COLUMN     "paused_until" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "steps" ADD COLUMN     "condition" "step_condition";

-- Hand-written (campaigns' docs/data.md). A pause names its reason exactly while paused, and an
-- enrollment's resume time only then; a campaign's pause carries its reason and instant.
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_paused" CHECK (
  ("paused_reason" IS NOT NULL) = ("status" = 'paused')
  AND ("paused_until" IS NULL OR "status" = 'paused')
);
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_paused" CHECK (
  ("paused_reason" IS NOT NULL) = ("status" = 'paused')
  AND ("paused_at" IS NOT NULL) = ("status" = 'paused')
);

-- A paused enrollment is still live: one live enrollment per person, and it has not ended.
DROP INDEX "enrollments_active_person";
CREATE UNIQUE INDEX "enrollments_active_person" ON "enrollments"("workspace_id", "person_id") WHERE "status" IN ('active', 'paused');
ALTER TABLE "enrollments" DROP CONSTRAINT "enrollments_ended_at";
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_ended_at" CHECK (("ended_at" IS NOT NULL) = ("status" NOT IN ('active', 'paused')));
