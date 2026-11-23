// The topic_engagement kind (README.md "Kinds"; briefs RB-4.1.1, RB-4.2.2): the posts that hold an
// exact phrase of 1 to 5 words, read through the sender's own account as far back as
// SIGNALS_TOPIC_LOOKBACK_DAYS, and their authors, commenters and reactors as `roles` keeps them. A
// phrase that names a special-category theme (BLOCKED_TOPIC_TERMS) is signal_topic_blocked: nothing is
// stored, nothing searched. Stored canonical: the phrase's words one space apart, the roles in order.
import { AppError } from "@whytide/platform";
import { POST_PHRASE_MAX_CHARS, POST_PHRASE_MAX_WORDS } from "@whytide/providers";
import { z } from "zod";
import { errors } from "../../errors.ts";
import { defineSourceKind } from "../_contract.ts";
import { postEvidenceOf } from "../_posts.ts";
import { POSTS_PAGE_SIZE } from "../constants.ts";
import { topicConfig } from "./config.ts";
import {
  BLOCKED_TOPIC_TERMS,
  ROLE_REACTIONS,
  ROLES,
  ROLES_SEPARATOR,
  type Role,
} from "./constants.ts";

/** A whole word: no letter or digit touches the match on either side. */
const EDGE = "[\\p{L}\\p{N}]";
const terms = BLOCKED_TOPIC_TERMS.map((term) => term.split(" ").join("\\s+"));
const BLOCKED = new RegExp(`(?<!${EDGE})(?:${terms.join("|")})s?(?!${EDGE})`, "iu");

/** The phrase names a blocked term. */
export const blockedTopic = (phrase: string): boolean => BLOCKED.test(phrase);

const phrase = z
  .string()
  .max(POST_PHRASE_MAX_CHARS * 2)
  .transform((value, context) => {
    const words = value.split(/\s+/u).filter((word) => word !== "");
    const text = words.join(" ");
    if (words.length > POST_PHRASE_MAX_WORDS || [...text].length > POST_PHRASE_MAX_CHARS) {
      context.addIssue({ code: "custom", message: `1 to ${POST_PHRASE_MAX_WORDS} words` });
    } else if (words.length === 0) context.addIssue({ code: "custom", message: "a phrase" });
    else if (blockedTopic(text)) {
      const details = { fields: ["config.phrase"] };
      throw new AppError(errors.signal_topic_blocked, { details });
    } else return text;
    return z.NEVER;
  });
const roles = z
  .array(z.string())
  .max(ROLES.length)
  .default([...ROLES])
  .transform((given, context) => {
    const kept = ROLES.filter((role) => given.includes(role));
    // Each given once, and each a role: none dropped, none twice.
    if (kept.length > 0 && kept.length === given.length) return kept;
    context.addIssue({ code: "custom", message: "author, commenter or reactor" });
    return z.NEVER;
  });

export const configSchema = z.strictObject({ phrase, roles });
export type TopicConfig = z.output<typeof configSchema>;

export const topicEngagement = defineSourceKind(
  {
    kind: "topic_engagement",
    configSchema,
    labelKey: "signals.kinds.topic_engagement.label",
    lookbackDays: topicConfig.SIGNALS_TOPIC_LOOKBACK_DAYS,
    schedule: (_config, savedAt) => [savedAt],
    cadence: "daily",
    reader: {
      source: (config) => ({ by: "phrase", phrase: config.phrase }),
      keepsAuthors: (config) => config.roles.includes("author"),
      keepsReactions: (config) => config.roles.flatMap((role: Role) => ROLE_REACTIONS[role]),
      pageSize: POSTS_PAGE_SIZE,
    },
    event: { kind: "topic_engagement" },
    evidenceOf: postEvidenceOf,
    // The roles separated by `;`, in any case; none, all three (the schema's default).
    csv: {
      names: ["topic"],
      config: ({ phrase, roles }) => {
        const given = roles.split(ROLES_SEPARATOR).map((role) => role.trim().toLowerCase());
        const named = given.filter((role) => role !== "");
        return { phrase, ...(named.length === 0 ? {} : { roles: named }) };
      },
      columns: { "config.phrase": "phrase", "config.roles": "roles" },
      label: (config) => config.phrase,
    },
  },
  import.meta.url,
);
