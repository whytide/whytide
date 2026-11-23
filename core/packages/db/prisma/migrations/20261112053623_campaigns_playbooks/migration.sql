-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "playbook_id" TEXT;

-- Hand-written (campaigns' docs/data.md). One campaign per agent: a partial unique key, which
-- Prisma's schema cannot say; the seeded campaign and any campaign without an agent hold none.
-- campaigns' subscriber to playbooks.playbook_created inserts ON CONFLICT DO NOTHING, so a
-- redelivered event makes no second campaign.
CREATE UNIQUE INDEX "campaigns_playbook" ON "campaigns"("workspace_id", "playbook_id") WHERE "playbook_id" IS NOT NULL;
