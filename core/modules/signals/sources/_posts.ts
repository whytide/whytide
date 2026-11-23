// What the posts kinds share (README.md "Kinds", "Runs"; gamma-p5-020): a post's unnamed URL, which
// a posts kind stages, stores and reads its engagers with; the erasure's match on a post's author; a
// post's author and a page of its engagers as candidates; their evidence.
import { engagersFile, type PostsFile } from "@whytide/linkedin";
import type { Candidate, Evidence, PageCandidates } from "./_contract.ts";
import { AUTHOR, UNNAMED_POST } from "./constants.ts";

const KIND = "(activity|share|ugcPost)";
const COLON = "(?::|%3[Aa])";
/** The two forms of post_engagers/post-url.ts, the kind and the id captured, as providers' POST_PATHS. */
const POST_FORMS = [
  new RegExp(`^/posts/[\\w%.~-]+-${KIND}-(\\d{1,30})-[\\w-]+/?$`),
  new RegExp(`^/feed/update/urn${COLON}li${COLON}${KIND}${COLON}(\\d{1,30})/?$`),
];
/** A /posts/ URL's segment: the author's public id, `_`, then the post's words. */
const POSTS_SEGMENT = /^\/posts\/([^/]+)\/?$/;

/** A post of a posts file. */
export type FiledPost = PostsFile["posts"][number];
/** The post a page of engagers belongs to: its unnamed URL and its excerpt, if any. */
export type PostOf = { readonly url: string; readonly excerpt?: string };

/** The post's unnamed URL, …/feed/update/urn:li:<kind>:<id>, from either form; null for none. */
export function unnamedPostUrl(url: string): string | null {
  const path = URL.parse(url)?.pathname ?? "";
  for (const form of POST_FORMS) {
    const [, kind, id] = form.exec(path) ?? [];
    if (kind !== undefined && id !== undefined) return `${UNNAMED_POST}${kind}:${id}`;
  }
  return null;
}

/** The text with its percent escapes decoded, when they decode, in lower case. */
export function decodedLower(text: string): string {
  try {
    return decodeURIComponent(text).toLowerCase();
  } catch {
    return text.toLowerCase();
  }
}

/** The URL is a /posts/<author>_<words>-… URL whose author is `slug` (decoded, lower case). */
export function namesAuthor(url: string, slug: string): boolean {
  const segment = POSTS_SEGMENT.exec(URL.parse(url)?.pathname ?? "")?.[1];
  return slug !== "" && segment !== undefined && decodedLower(segment).startsWith(`${slug}_`);
}

/** The post's author as a candidate, `author`, their post their own words; none for a company. */
export function authorOf(post: FiledPost, url: string): Candidate | null {
  if (post.author.kind !== "member") return null;
  const { providerMemberRef, profileUrl, name, headline } = post.author;
  const words = post.excerpt === "" ? {} : { commentText: post.excerpt };
  const at = { engagedAt: new Date(post.postedAt), dateKnown: true };
  return {
    providerMemberRef,
    profileUrl,
    name,
    headline,
    reaction: AUTHOR,
    ...words,
    ...at,
    objectUrl: url,
  };
}

/**
 * A page file of a post's engagers as candidates of the post, newest first: those at `cut` or after
 * it whose reaction `kept` holds, each with the post's excerpt; the page reached the cut when it
 * holds one before it. One at the cut exactly may be the run before's newest, staged again.
 */
export function engagersOf(
  file: unknown,
  post: PostOf,
  cut: Date,
  kept: readonly string[],
): PageCandidates {
  const candidates: Candidate[] = [];
  let reachedCut = false;
  const excerpt = post.excerpt ? { postExcerpt: post.excerpt } : {};
  for (const { engagedAt, ...engager } of engagersFile.parse(file).engagers) {
    const at = new Date(engagedAt);
    if (at.getTime() < cut.getTime()) reachedCut = true;
    else if (kept.includes(engager.reaction)) {
      candidates.push({ ...engager, engagedAt: at, objectUrl: post.url, ...excerpt });
    }
  }
  return { candidates, reachedCut };
}

/**
 * When the candidate engaged, as staged (gamma-p5-020): an undated engager, whose `engagedAt` is the
 * listing's time (Unipile's reactions; a reaction in a page before gamma-p5-010), at `floor`, never
 * later than the listing.
 */
export function stagedAt(candidate: Candidate, floor: Date): Date {
  const { dateKnown, reaction, engagedAt } = candidate;
  const undated = dateKnown === false || (dateKnown === undefined && reaction !== "comment");
  return undated && engagedAt > floor ? floor : engagedAt;
}

/** A posts kind's evidence: an author's own post is their excerpt; an engager's post is not. */
export function postEvidenceOf(candidate: Candidate): Evidence {
  const { objectUrl: url, reaction, commentText, postExcerpt, name: author } = candidate;
  if (reaction === AUTHOR) return { url, reaction, ownWords: commentText, author };
  return { url, reaction, commentText, postExcerpt, author };
}
