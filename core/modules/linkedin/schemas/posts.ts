// The posts read of a signal run (README.md "Worker"; workflows/posts.ts linkedin_read_posts,
// gamma-p5-015), the profile read's sibling: the source, the date it reads back to and the page's
// size come in a request file, and the page goes out in a file, both under the workspace's raw/, so
// that no workflow input, result or history holds a phrase, an author's link, an excerpt or a name.
// The vendor's cursor stays in the page file too, as it may hold the author's vendor id or the
// phrase: the next page's request names the previous page's file (`after`), and the activity reads
// the cursor there. Business fields only, as the port parses them (docs/security.md).
import { linkedinPort, linkedinPost } from "@whytide/providers";
import { z } from "zod";
import { RAW_FILE_KEY, RAW_FILE_KEY_MAX_CHARS } from "./constants.ts";

const { searchPosts, listAuthorPosts } = linkedinPort.methods;
/** A JSON file under the workspace's raw/, as a key relative to its folder. */
export const rawFileKey = z.string().max(RAW_FILE_KEY_MAX_CHARS).regex(RAW_FILE_KEY);

/** The activity's input, which workflows/posts.ts parses: ids and the two files' keys. */
export type ReadPosts = {
  readonly workspaceId: string;
  readonly accountId: string;
  /** The request file the caller wrote (postsRequestFile), under raw/. */
  readonly requestKey: string;
  /** Where the page goes (postsFile), under the workspace's folder and in raw/ (72 hours at most). */
  readonly rawKey: string;
};
/** A page read: its file's whole key, its posts' count, and whether a page follows it. */
export type PostsRead = { readonly key: string; readonly count: number; readonly more: boolean };
/**
 * No page, and no retry: the account is not connected, or the author is unknown or out of its
 * sight; or, before the call, a kill switch holds, or the account is paused or held by its retry_at
 * (workflows/reads.ts beforeRead).
 */
export type PostsRefused = {
  readonly refused:
    | "linkedin_account_disconnected"
    | "linkedin_not_found"
    | "account_paused"
    | "linkedin_rate_limited"
    | "platform_stopped"
    | "workspace_stopped"
    | "account_stopped";
};

/** Whose posts: those that hold an exact phrase, a member's or a company page's, the account's own. */
const source = z.discriminatedUnion("by", [
  z.strictObject({ by: z.literal("phrase"), phrase: searchPosts.input.shape.phrase }),
  z.strictObject({ by: z.literal("author"), authorUrl: listAuthorPosts.input.shape.authorUrl }),
  z.strictObject({ by: z.literal("own") }),
]);
/**
 * The request file: the source, the date the read goes back to (ISO) and the page's size, each as
 * the port bounds it; for a page after the first, `after`, the key of the previous page's file, whose
 * cursor the read goes on from.
 */
export const postsRequestFile = z.strictObject({
  source,
  postedSince: z.iso.datetime(),
  after: rawFileKey.optional(),
  limit: searchPosts.input.shape.limit,
});
export type PostsRequestFile = z.output<typeof postsRequestFile>;
/**
 * The page file: the port's posts as it answered them, newest first, `postedAt` in ISO, and the
 * vendor's cursor of the next page, null on the last, which only the next request's read opens.
 */
export const postsFile = z.strictObject({
  posts: z.array(z.strictObject({ ...linkedinPost.shape, postedAt: z.iso.datetime() })),
  nextCursor: searchPosts.output.shape.nextCursor,
});
export type PostsFile = z.output<typeof postsFile>;
