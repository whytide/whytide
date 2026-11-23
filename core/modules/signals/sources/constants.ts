// The constants the kinds share (README.md "Kinds", "Runs"): the reads a run calls by name, the
// pages they ask for, the engagers' reactions, a post author's role and a post's unnamed URL; an
// author page's link, as the competitor and creator kinds store it (gamma-p5-025).

/** linkedin's read of a post's engagers, a page at a time: every kind's but the posts' own read. */
export const ENGAGERS_READER = "linkedin_read_post_engagers";
/** The engagers a page asks for. */
export const ENGAGERS_PAGE_SIZE = 25;
/** The posts a page asks for: a phrase's page above 49 posts costs two vendor loads (gamma-p5-015). */
export const POSTS_PAGE_SIZE = 10;
/** The reactions of linkedin's engagers file. */
export const REACTIONS: readonly string[] = Object.freeze(["like", "comment", "repost"]);
/** The role of a post's author, a candidate's reaction. */
export const AUTHOR = "author";
/** A post's unnamed URL up to its URN's kind: no author, no words, and it still opens the post. */
export const UNNAMED_POST = "https://www.linkedin.com/feed/update/urn:li:";
/** The start of a post's URL that names its author, /posts/<author>_<words>-…, as signals stores it. */
export const NAMED_POSTS = "https://www.linkedin.com/posts/";
/** The hosts a LinkedIn link takes: a post's (post-url.ts), an author page's (_authors.ts). */
export const LINKEDIN_HOSTS: ReadonlySet<string> = new Set(["linkedin.com", "www.linkedin.com"]);
/** The longest link a config field takes. */
export const LINK_MAX_CHARS = 2048;
/** The start of a LinkedIn page's link as signals stores it: https on www.linkedin.com. */
export const LINKEDIN_ORIGIN = "https://www.linkedin.com";
/** An author's page up to its id, by its kind in providers' AUTHOR_PATHS (_authors.ts). */
export const AUTHOR_PREFIXES = { member: "/in/", company: "/company/" } as const;
/** The longest label a source takes, as the routes' schema reads it (schemas/sources.ts). */
export const LABEL_MAX_CHARS = 100;
/** The start of a stored link a CSV row's label leaves out (_csv.ts). */
export const LINK_LABEL_START = "https://www.";
