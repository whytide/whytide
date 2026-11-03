-- CreateEnum
CREATE TYPE "suppression_layer" AS ENUM ('blocklist', 'opt_out');

-- CreateEnum
CREATE TYPE "suppression_match_type" AS ENUM ('linkedin_url', 'domain');

-- CreateEnum
CREATE TYPE "suppression_channel" AS ENUM ('all');

-- CreateEnum
CREATE TYPE "suppression_source" AS ENUM ('manual', 'system');

-- AlterTable
ALTER TABLE "persons" ADD COLUMN     "last_touch_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "suppression_entries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "layer" "suppression_layer" NOT NULL,
    "match_type" "suppression_match_type" NOT NULL,
    "hash" TEXT NOT NULL,
    "linkedin_url" TEXT,
    "domain" TEXT,
    "channel" "suppression_channel" NOT NULL DEFAULT 'all',
    "source" "suppression_source" NOT NULL,
    "reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by" TEXT,

    CONSTRAINT "suppression_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppression_entries_workspace_id_hash_idx" ON "suppression_entries"("workspace_id", "hash");

-- Hand-written (prisma/schema/contacts.prisma points here). One active entry per key: an entry
-- removed by hand leaves the key free for a new one, and `layer` is part of the key, so a blocked
-- person can opt out as well, and removing the block leaves the opt-out in force (contacts'
-- docs/data.md). Prisma cannot say a partial index.
CREATE UNIQUE INDEX "suppression_entries_active_key" ON "suppression_entries"("workspace_id", "layer", "match_type", "hash", "channel") WHERE "removed_at" IS NULL;

-- The raw value sits in the column of its match type: a profile or company page in linkedin_url, a
-- domain in domain. Erasure empties linkedin_url and keeps the hash, which is all the match reads.
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_linkedin_url_match" CHECK ("linkedin_url" IS NULL OR "match_type" = 'linkedin_url');
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_domain_match" CHECK (("domain" IS NOT NULL) = ("match_type" = 'domain'));

-- An opt-out is never removed (data model §5.1), whoever writes the row.
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_opt_out_kept" CHECK ("layer" <> 'opt_out' OR "removed_at" IS NULL);

-- Grants and policy as contacts' other tables (20261022150500_contacts_initial): the owner's default
-- privileges give app SELECT, INSERT, UPDATE and DELETE (20261021000000_db_roles); no row-level policy
-- before zeta (docs/rules/security.md §3).
