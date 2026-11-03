-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "sender_action_kind" ADD VALUE 'pending_invites';
ALTER TYPE "sender_action_kind" ADD VALUE 'relation_check';

-- AlterTable
ALTER TABLE "sender_accounts" ADD COLUMN     "pending_invites" INTEGER,
ADD COLUMN     "pending_invites_checked_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "sender_outreach" ADD COLUMN     "relation_checked_at" TIMESTAMPTZ;

-- Hand-written (prisma/schema/linkedin.prisma points here). The pending invitations the day's check
-- counted, plus the invites committed since (core/modules/linkedin domain/invites/): never below 0.
-- Every existing account starts unknown, null, so it sends no invite before its first check.
ALTER TABLE "sender_accounts" ADD CONSTRAINT "sender_accounts_pending_invites" CHECK ("pending_invites" >= 0);
