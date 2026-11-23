// The creator_engagement kind (README.md "Kinds"; briefs RB-4.1.1, reduced): the engagers of a
// creator's posts, read through the sender's own account as far back as
// SIGNALS_CREATOR_LOOKBACK_DAYS. Config { profileUrl }: the creator's profile link, stored canonical
// (_authors.ts). The creator's own posts are not leads, so no author is kept. The creator's erasure
// disables the source and empties its link (scrub; README.md "Reduction").
import { z } from "zod";
import { authorUrl, namesMember } from "../_authors.ts";
import { defineSourceKind } from "../_contract.ts";
import { linkLabel } from "../_csv.ts";
import { postEvidenceOf } from "../_posts.ts";
import { POSTS_PAGE_SIZE, REACTIONS } from "../constants.ts";
import { creatorConfig } from "./config.ts";

export const configSchema = z.strictObject({ profileUrl: authorUrl("member") });
export type CreatorConfig = z.output<typeof configSchema>;

export const creatorEngagement = defineSourceKind(
  {
    kind: "creator_engagement",
    configSchema,
    labelKey: "signals.kinds.creator_engagement.label",
    lookbackDays: creatorConfig.SIGNALS_CREATOR_LOOKBACK_DAYS,
    schedule: (_config, savedAt) => [savedAt],
    cadence: "daily",
    reader: {
      source: (config) => ({ by: "author", authorUrl: config.profileUrl }),
      keepsAuthors: () => false,
      keepsReactions: () => REACTIONS,
      pageSize: POSTS_PAGE_SIZE,
    },
    event: { kind: "creator_engagement" },
    evidenceOf: postEvidenceOf,
    // Disabled, not re-pointed: the source reads one creator, and their erasure ends it.
    scrub: (config, slug) => (namesMember(config.profileUrl, slug) ? { profileUrl: "" } : null),
    csv: {
      names: ["creator"],
      config: ({ url }) => ({ profileUrl: url }),
      columns: { "config.profileUrl": "url" },
      label: (config) => linkLabel(config.profileUrl),
    },
  },
  import.meta.url,
);
