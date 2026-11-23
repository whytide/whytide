// The email source `website` (README "The sources reply, website and pattern"; gamma-en-085): the
// company's site read with en-065's reader and browser fallback (site.ts), contact, team, about,
// imprint and legal pages first, at most ENRICHMENT_SITE_MAX_PAGES. In code, the addresses at the
// company's domain in the pages' text and `mailto:` links: the lead's own is a candidate, the others
// give the domain's pattern (../../email/site.ts), its row's site_seen_at set and its count left
// (gamma-rf-030); the others and the names around them are dropped in this activity, never stored,
// logged or passed on. robots.txt allowing no page is `blocked`; a site that cannot be read, the
// reader's code. No AI, no outside call but the site's.
import { mailtoOf, SITE_CODES } from "@whytide/platform";
import { now } from "../../clock.ts";
import {
  EMAIL_SITE_PREFERRED,
  OUTCOMES,
  SOURCE_CLASSES,
  WEBSITE_EMAIL,
  WEBSITE_EMAIL_TIMEOUT_SECONDS,
} from "../../email/constants.ts";
import { writePattern } from "../../email/domain-pattern.ts";
import { namesOf } from "../../email/names.ts";
import { readSiteAddresses } from "../../email/site.ts";
import { defineSource, type EmailSourceAnswer } from "../define.ts";
import { BLOCKED } from "./constants.ts";
import { readCompanySite } from "./site.ts";

export const websiteEmailSource = defineSource({
  name: WEBSITE_EMAIL,
  kind: "email",
  activityKind: "provider",
  timeoutSeconds: WEBSITE_EMAIL_TIMEOUT_SECONDS,
  provenance: { source: SOURCE_CLASSES.website, provider: WEBSITE_EMAIL },
  run: async ({ firstName, lastName, companyDomain }, context): Promise<EmailSourceAnswer> => {
    if (companyDomain === "") return { found: false };
    const beat = () => context.beat?.();
    const read = await readCompanySite(companyDomain, beat, EMAIL_SITE_PREFERRED);
    if (!read.ok) {
      return { found: false, outcome: read.code === SITE_CODES.disallowed ? BLOCKED : read.code };
    }
    // A rendered page's mailto links join its links (site.ts): read them as the reader does.
    const pages = read.pages.map(({ text, mailto, links }) => ({
      text,
      mailto: [...mailto, ...mailtoOf(links)],
    }));
    const { own, pattern } = readSiteAddresses(pages, companyDomain, namesOf(firstName, lastName));
    if (pattern !== null) {
      await context.tenant(() => writePattern(companyDomain, pattern, "website", now()));
    }
    if (own.length === 0) {
      return pattern === null ? { found: false } : { found: false, outcome: OUTCOMES.patternFound };
    }
    return { found: true, candidates: own.map((address) => ({ address })) };
  },
});
