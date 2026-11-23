-- CreateEnum
CREATE TYPE "suppression_relationship" AS ENUM ('customer', 'competitor');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "suppression_channel" ADD VALUE 'linkedin';
ALTER TYPE "suppression_channel" ADD VALUE 'email';

-- AlterEnum
ALTER TYPE "suppression_layer" ADD VALUE 'relationship';

-- AlterTable
ALTER TABLE "suppression_entries" ADD COLUMN     "relationship" "suppression_relationship";

-- Hand-written (prisma/schema/contacts.prisma points here; contacts' docs/data.md). An opt-out
-- holds every channel at once (RB-20.3.1), whoever writes the row.
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_opt_out_every_channel" CHECK ("layer" <> 'opt_out' OR "channel" = 'all');

-- A relationship entry, and it alone, names its relationship, customer or competitor, and it is on a
-- company's domain. The layer is compared as text: Postgres refuses the value `relationship` inside
-- the transaction that adds it (20261029092149_messaging_step_drafts does the same).
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_relationship_match" CHECK (
    ("layer"::text = 'relationship') = ("relationship" IS NOT NULL)
    AND ("layer"::text <> 'relationship' OR "match_type" = 'domain')
  );

-- No entry is ever deleted (beta's open item, the 2026-10-29 beta-p2-010 decision): removing one sets
-- removed_at, an opt-out keeps none (suppression_entries_opt_out_kept), and erasure empties
-- linkedin_url and keeps the row and its hash. app keeps SELECT, INSERT and UPDATE.
REVOKE DELETE ON TABLE "suppression_entries" FROM app;
