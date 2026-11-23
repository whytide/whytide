// The topic_engagement kind's constants (README.md "Kinds"): the roles a source keeps and the
// engagers' reactions each takes, and the terms a phrase may not hold.

/** Who a topic keeps: the post's author, its commenters, its reactors (a like or a repost). */
export const ROLES = ["author", "commenter", "reactor"] as const;
export type Role = (typeof ROLES)[number];
/** What separates the roles in a sources CSV's `roles` cell (README.md "Importing sources"). */
export const ROLES_SEPARATOR = ";";
/** The engagers' reactions of each role; an author is no engager. */
export const ROLE_REACTIONS: Readonly<Record<Role, readonly string[]>> = {
  author: [],
  commenter: ["comment"],
  reactor: ["like", "repost"],
};

/**
 * The special-category themes a phrase may not name (RB-4.2.2, F03 R9), as whole words in any case,
 * a plural `s` too: health, religion, politics, sexual orientation, ethnicity, union membership. A
 * list of words, not of meanings (the task's Open questions).
 */
export const BLOCKED_TOPIC_TERMS: readonly string[] = Object.freeze([
  ...["health", "illness", "disease", "diagnosis", "disability", "pregnancy", "cancer"],
  ...["diabetes", "depression", "hiv", "autism", "adhd", "mental health"],
  ...["religion", "religious", "faith", "church", "mosque", "synagogue", "christian", "muslim"],
  ...["islam", "jewish", "hindu", "buddhist", "atheist"],
  ...["politics", "political", "election", "democrat", "republican", "conservative"],
  ...["socialist", "communist", "voting"],
  ...["sexual orientation", "sexuality", "gay", "lesbian", "bisexual", "lgbt", "lgbtq", "queer"],
  ...["transgender"],
  ...["ethnicity", "ethnic", "racial", "racism", "race"],
  ...["union", "trade union", "labor union", "labour union", "unionize", "unionise"],
  ...["unionized", "unionised"],
]);
