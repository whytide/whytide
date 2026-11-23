// A company domain's address patterns (docs/data.md "email_domain_patterns"; gamma-rf-030), in the
// caller's tenant run on the global tables: what the pattern source reads, a domain's live catch-all
// status (email_domain_statuses) and its patterns verified or seen within PATTERN_DAYS, the most
// proven first; and the writes, one row per domain and pattern, each one statement: a verified
// address's pattern counted (`verified`), a site's pattern seen (`website`), which never changes a
// count. Nothing replaces anything, so two writes at once lose no count. A pattern is a fixed name,
// never an address; a row past its days is left unread, never deleted.
import { tenantClient } from "@whytide/db";
import { newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import { DAY_MS } from "../constants.ts";
import { CATCH_ALL_STATUS_DAYS } from "../lookup/constants.ts";
import { PATTERN_DAYS, type Pattern } from "./constants.ts";
import { rankPatterns } from "./patterns.ts";

export type PatternSource = "website" | "verified";
export type DomainStatus = { readonly catchAll: boolean; readonly patterns: readonly Pattern[] };

/** The domain recorded catch-all now, and its patterns within PATTERN_DAYS, the most proven first. */
export async function domainStatusOf(domain: string, at: Date): Promise<DomainStatus> {
  const status = await tenantClient.emailDomainStatus.findFirst({
    where: { domain },
    select: { catchAll: true, expiresAt: true },
  });
  const catchAll = status !== null && status.catchAll && status.expiresAt.getTime() > at.getTime();
  const since = new Date(at.getTime() - PATTERN_DAYS * DAY_MS);
  const rows = await tenantClient.emailDomainPattern.findMany({
    where: { domain, OR: [{ lastVerifiedAt: { gt: since } }, { siteSeenAt: { gt: since } }] },
    select: { pattern: true, verifiedCount: true, lastVerifiedAt: true, siteSeenAt: true },
  });
  return { catchAll, patterns: rankPatterns(rows) };
}

/**
 * The domain's pattern written at `at`, in one statement: `verified` adds 1 to its count and sets
 * when it was last verified; `website` sets when the site last showed it and leaves the count.
 */
export async function writePattern(
  domain: string,
  pattern: Pattern,
  source: PatternSource,
  at: Date,
): Promise<void> {
  if (source === "verified") {
    await tenantClient.$executeRaw`
      INSERT INTO email_domain_patterns (domain, pattern, verified_count, last_verified_at,
        created_at)
      VALUES (${domain}, ${pattern}, 1, ${at}::timestamptz, ${at}::timestamptz)
      ON CONFLICT (domain, pattern) DO UPDATE SET
        verified_count = email_domain_patterns.verified_count + 1,
        last_verified_at = GREATEST(email_domain_patterns.last_verified_at,
          EXCLUDED.last_verified_at)`;
    return;
  }
  await tenantClient.$executeRaw`
    INSERT INTO email_domain_patterns (domain, pattern, verified_count, site_seen_at, created_at)
    VALUES (${domain}, ${pattern}, 0, ${at}::timestamptz, ${at}::timestamptz)
    ON CONFLICT (domain, pattern) DO UPDATE SET
      site_seen_at = GREATEST(email_domain_patterns.site_seen_at, EXCLUDED.site_seen_at)`;
}

/**
 * The domain recorded catch-all at `at` for CATCH_ALL_STATUS_DAYS, for every workspace: a verifier's
 * `catch_all` on a work address of the company's own domain. The row holds the domain, the adapter
 * that said so and two times, never an address or a name.
 */
export async function writeCatchAll(domain: string, provider: string, at: Date): Promise<void> {
  const expiresAt = new Date(at.getTime() + CATCH_ALL_STATUS_DAYS * DAY_MS);
  const values = { catchAll: true, provider, checkedAt: at, expiresAt };
  await tenantClient.emailDomainStatus.upsert({
    where: { domain },
    create: { id: newId(ids.email_domain_status), domain, ...values },
    update: values,
  });
}
