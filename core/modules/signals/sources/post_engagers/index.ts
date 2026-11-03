// The post_engagers kind (README.md "Kinds"; briefs RB-4.1.2): the people who reacted to, commented
// on or reposted one LinkedIn post, read through the sender's own account at save, then three and
// seven days later, as far back as SIGNALS_POST_ENGAGERS_LOOKBACK_DAYS. linkedin's
// linkedin_read_post_engagers reads each page and writes it to a file, which pageOf reads.
import { engagersFile } from "@whytide/linkedin";
import { z } from "zod";
import { type Candidate, defineSourceKind, type PageCandidates } from "../_contract.ts";
import { postEngagersConfig } from "./config.ts";
import { postUrl } from "./post-url.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The days after the save on which a source runs (RB-4.1.2). */
const RUN_DAYS = [0, 3, 7] as const;
/** The engagers a page asks for. */
export const PAGE_SIZE = 25;

export const configSchema = z.strictObject({ postUrl });
export type PostEngagersConfig = z.output<typeof configSchema>;

/** At save, then three and seven days later. */
export function schedule(_config: PostEngagersConfig, savedAt: Date): Date[] {
  return RUN_DAYS.map((days) => new Date(savedAt.getTime() + days * DAY_MS));
}

/**
 * A page file's engagers who engaged at `cut` or after it, as candidates of the post; the page
 * reached the cut when it holds one before it (the port pages newest first). One at the cut exactly
 * may be the run before's newest, staged again: its staging key keeps it once in the run.
 */
export function pageOf(file: unknown, config: PostEngagersConfig, cut: Date): PageCandidates {
  const candidates: Candidate[] = [];
  let reachedCut = false;
  for (const { engagedAt, ...engager } of engagersFile.parse(file).engagers) {
    const at = new Date(engagedAt);
    if (at.getTime() < cut.getTime()) reachedCut = true;
    else candidates.push({ ...engager, engagedAt: at, objectUrl: config.postUrl });
  }
  return { candidates, reachedCut };
}

export const postEngagers = defineSourceKind(
  {
    kind: "post_engagers",
    configSchema,
    labelKey: "signals.kinds.post_engagers.label",
    lookbackDays: postEngagersConfig.SIGNALS_POST_ENGAGERS_LOOKBACK_DAYS,
    schedule,
    reader: {
      activity: "linkedin_read_post_engagers",
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
  },
  import.meta.url,
);
