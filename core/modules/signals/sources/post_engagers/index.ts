// The post_engagers kind (README.md "Kinds"; briefs RB-4.1.2): the people who reacted to, commented
// on or reposted one LinkedIn post, read through the sender's own account at save, then three and
// seven days later, within SIGNALS_POST_ENGAGERS_LOOKBACK_DAYS of the save and as far back: the post
// has no date, so the source ends there (gamma-p5-020). linkedin's linkedin_read_post_engagers reads
// each page and writes it to a file, which pageOf reads.
import { z } from "zod";
import { defineSourceKind, type PageCandidates } from "../_contract.ts";
import { linkLabel } from "../_csv.ts";
import { engagersOf, namesAuthor } from "../_posts.ts";
import { ENGAGERS_PAGE_SIZE, ENGAGERS_READER, REACTIONS } from "../constants.ts";
import { postEngagersConfig } from "./config.ts";
import { postUrl } from "./post-url.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The days after the save on which a source runs (RB-4.1.2). */
const RUN_DAYS = [0, 3, 7] as const;
const LOOKBACK_DAYS = postEngagersConfig.SIGNALS_POST_ENGAGERS_LOOKBACK_DAYS;
/** The engagers a page asks for. */
export const PAGE_SIZE = ENGAGERS_PAGE_SIZE;

export const configSchema = z.strictObject({ postUrl });
export type PostEngagersConfig = z.output<typeof configSchema>;

/** At save, then three and seven days later, those within `lookbackDays` of the save. */
export function fireTimes(savedAt: Date, lookbackDays = LOOKBACK_DAYS): Date[] {
  const within = RUN_DAYS.filter((days) => days <= lookbackDays);
  return within.map((days) => new Date(savedAt.getTime() + days * DAY_MS));
}

/** The schedule: fireTimes within the lookback. */
export const schedule = (_config: PostEngagersConfig, savedAt: Date): Date[] => fireTimes(savedAt);

/**
 * A page file's engagers who engaged at `cut` or after it, as candidates of the post, `dateKnown`
 * kept for the staging's dating; the page reached the cut when it holds one before it (the port
 * pages newest first). One at the cut exactly may be the run before's newest, staged again: its
 * staging key keeps it once in the run.
 */
export function pageOf(file: unknown, config: PostEngagersConfig, cut: Date): PageCandidates {
  return engagersOf(file, { url: config.postUrl }, cut, REACTIONS);
}

export const postEngagers = defineSourceKind(
  {
    kind: "post_engagers",
    configSchema,
    labelKey: "signals.kinds.post_engagers.label",
    lookbackDays: LOOKBACK_DAYS,
    schedule,
    endsAt: (savedAt) => new Date(savedAt.getTime() + LOOKBACK_DAYS * DAY_MS),
    reader: {
      activity: ENGAGERS_READER,
      input: (config) => ({ postUrl: config.postUrl }),
      pageSize: PAGE_SIZE,
      page: pageOf,
    },
    event: { kind: "post_engagement", objectOf: (config) => config.postUrl },
    evidenceOf: ({ objectUrl, reaction, commentText, name }) => ({
      url: objectUrl,
      reaction,
      ...(commentText === undefined ? {} : { commentText }),
      author: name,
    }),
    // A post on the person's post is disabled, not given the unnamed URL: a new URL would change
    // its events' dedupe keys, and its next run would count every engagement again.
    scrub: (config, slug) => (namesAuthor(config.postUrl, slug) ? { postUrl: "" } : null),
    csv: {
      names: ["post"],
      config: ({ url }) => ({ postUrl: url }),
      columns: { "config.postUrl": "url" },
      label: (config) => linkLabel(config.postUrl),
    },
  },
  import.meta.url,
);
