// The my_post_engagement kind (README.md "Kinds"; briefs RB-4.1.2, reduced): the engagers of the
// sender account's own posts, read through that account as far back as SIGNALS_MY_POST_LOOKBACK_DAYS.
// Its config is empty: the account is the source's sender account.
import { z } from "zod";
import { defineSourceKind } from "../_contract.ts";
import { postEvidenceOf } from "../_posts.ts";
import { POSTS_PAGE_SIZE, REACTIONS } from "../constants.ts";
import { myPostConfig } from "./config.ts";

export const configSchema = z.strictObject({});

export const myPostEngagement = defineSourceKind(
  {
    kind: "my_post_engagement",
    configSchema,
    labelKey: "signals.kinds.my_post_engagement.label",
    lookbackDays: myPostConfig.SIGNALS_MY_POST_LOOKBACK_DAYS,
    schedule: (_config, savedAt) => [savedAt],
    cadence: "daily",
    reader: {
      source: () => ({ by: "own" }),
      keepsAuthors: () => false,
      keepsReactions: () => REACTIONS,
      pageSize: POSTS_PAGE_SIZE,
    },
    event: { kind: "my_post_engagement" },
    evidenceOf: postEvidenceOf,
  },
  import.meta.url,
);
