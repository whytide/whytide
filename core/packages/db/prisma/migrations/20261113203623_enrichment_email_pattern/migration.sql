-- gamma-en-085: a company domain's address pattern on email_domain_statuses (core/modules/enrichment
-- docs/data.md). Expand only: three nullable columns the previous release neither reads nor writes.

-- CreateEnum
CREATE TYPE "email_pattern_source" AS ENUM ('website', 'verified');

-- AlterTable
ALTER TABLE "email_domain_statuses" ADD COLUMN     "pattern" TEXT,
ADD COLUMN     "pattern_checked_at" TIMESTAMPTZ,
ADD COLUMN     "pattern_source" "email_pattern_source";

-- Hand-written: the pattern is one of the fixed names (enrichment's domain/email/patterns.ts),
-- never an address, and its three columns are set together or none.
ALTER TABLE "email_domain_statuses" ADD CONSTRAINT "email_domain_statuses_pattern" CHECK (
  (
    "pattern" IS NULL AND "pattern_source" IS NULL AND "pattern_checked_at" IS NULL
  ) OR (
    "pattern" IN (
      '{first}.{last}', '{first}', '{f}{last}', '{first}{last}', '{f}.{last}', '{first}_{last}',
      '{last}', '{first}-{last}', '{last}.{first}', '{first}{l}'
    )
    AND "pattern_source" IS NOT NULL AND "pattern_checked_at" IS NOT NULL
  )
);
