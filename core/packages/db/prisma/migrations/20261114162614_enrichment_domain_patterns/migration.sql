-- gamma-rf-030: a company domain's address patterns, one row per pattern (core/modules/enrichment
-- docs/data.md). Expand only: a new global table, today's patterns copied into it; the three pattern
-- columns of email_domain_statuses stay, no longer read or written, until the owner approves their
-- drop. No personal data: a domain, a pattern's name, a count and two times.

-- CreateTable
CREATE TABLE "email_domain_patterns" (
    "domain" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "verified_count" INTEGER NOT NULL DEFAULT 0,
    "last_verified_at" TIMESTAMPTZ,
    "site_seen_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_domain_patterns_pkey" PRIMARY KEY ("domain","pattern")
);

-- Hand-written (prisma/schema/enrichment.prisma points here): the pattern is one of the fixed names
-- (enrichment's domain/email/constants.ts, the list of email_domain_statuses_pattern), never an
-- address; a row was verified or seen on the site at least once; the count is above 0 exactly when
-- an address was verified. The app reads, inserts and updates and never deletes: a pattern past its
-- days is only left unread.
ALTER TABLE "email_domain_patterns" ADD CONSTRAINT "email_domain_patterns_pattern" CHECK (
    "pattern" IN (
      '{first}.{last}', '{first}', '{f}{last}', '{first}{last}', '{f}.{last}', '{first}_{last}',
      '{last}', '{first}-{last}', '{last}.{first}', '{first}{l}'
    )
  ),
  ADD CONSTRAINT "email_domain_patterns_seen" CHECK (
    "last_verified_at" IS NOT NULL OR "site_seen_at" IS NOT NULL
  ),
  ADD CONSTRAINT "email_domain_patterns_count" CHECK (
    "verified_count" >= 0 AND ("verified_count" > 0) = ("last_verified_at" IS NOT NULL)
  );
REVOKE DELETE ON TABLE "email_domain_patterns" FROM app;

-- Hand-written: today's pattern of each domain copied, a verified one with a count of 1 and its
-- time, a site's with a count of 0 and its time.
INSERT INTO "email_domain_patterns" ("domain", "pattern", "verified_count", "last_verified_at",
  "site_seen_at")
SELECT "domain", "pattern",
  CASE WHEN "pattern_source" = 'verified' THEN 1 ELSE 0 END,
  CASE WHEN "pattern_source" = 'verified' THEN "pattern_checked_at" END,
  CASE WHEN "pattern_source" = 'website' THEN "pattern_checked_at" END
FROM "email_domain_statuses"
WHERE "pattern" IS NOT NULL;
