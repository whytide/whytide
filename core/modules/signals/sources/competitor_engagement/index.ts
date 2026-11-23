// The competitor_engagement kind (README.md "Kinds"; briefs RB-4.1.1, reduced): the engagers of a
// company page's posts, a competitor's, read through the sender's own account as far back as
// SIGNALS_COMPETITOR_LOOKBACK_DAYS. Config { companyUrl, companyName }: the page's link, stored
// canonical (_authors.ts), and the name the tester gives, its words one space apart, 2 to 100
// characters: the port has no company read, and gamma-p5-030's filter of competitors' staff reads
// both. A company's post has no author candidate (_posts.ts authorOf), so none is kept; a company is
// no person, so the erasure scrubs nothing here.
import { z } from "zod";
import { authorUrl } from "../_authors.ts";
import { defineSourceKind } from "../_contract.ts";
import { postEvidenceOf } from "../_posts.ts";
import { POSTS_PAGE_SIZE, REACTIONS } from "../constants.ts";
import { competitorConfig } from "./config.ts";
import {
  COMPANY_NAME_GIVEN_MAX_CHARS,
  COMPANY_NAME_MAX_CHARS,
  COMPANY_NAME_MIN_CHARS,
  CONTROL_CHARACTER,
} from "./constants.ts";

const companyName = z
  .string()
  .max(COMPANY_NAME_GIVEN_MAX_CHARS)
  .transform((value, context) => {
    const name = value
      .split(/\s+/u)
      .filter((word) => word !== "")
      .join(" ");
    const chars = [...name].length;
    const bounded = chars >= COMPANY_NAME_MIN_CHARS && chars <= COMPANY_NAME_MAX_CHARS;
    if (bounded && name.isWellFormed() && !CONTROL_CHARACTER.test(name)) return name;
    const message = `${COMPANY_NAME_MIN_CHARS} to ${COMPANY_NAME_MAX_CHARS} characters`;
    context.addIssue({ code: "custom", message });
    return z.NEVER;
  });

export const configSchema = z.strictObject({ companyUrl: authorUrl("company"), companyName });
export type CompetitorConfig = z.output<typeof configSchema>;

export const competitorEngagement = defineSourceKind(
  {
    kind: "competitor_engagement",
    configSchema,
    labelKey: "signals.kinds.competitor_engagement.label",
    lookbackDays: competitorConfig.SIGNALS_COMPETITOR_LOOKBACK_DAYS,
    schedule: (_config, savedAt) => [savedAt],
    cadence: "daily",
    reader: {
      source: (config) => ({ by: "author", authorUrl: config.companyUrl }),
      keepsAuthors: () => false,
      keepsReactions: () => REACTIONS,
      pageSize: POSTS_PAGE_SIZE,
    },
    event: { kind: "competitor_engagement" },
    evidenceOf: postEvidenceOf,
    // A competitor is a company's page: `company` in a CSV, `competitor` too.
    csv: {
      names: ["company", "competitor"],
      config: ({ url, name }) => ({ companyUrl: url, companyName: name }),
      columns: { "config.companyUrl": "url", "config.companyName": "name" },
      label: (config) => config.companyName,
    },
  },
  import.meta.url,
);
