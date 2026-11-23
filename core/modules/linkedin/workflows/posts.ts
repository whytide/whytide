// The posts read of a signal run (README.md "Worker"; gamma-p5-015), the profile read's sibling:
// linkedin_read_posts reads its source, date and page size from the request file at `requestKey`,
// and after a first page the vendor's cursor from the previous page's file (`after`), so that no
// phrase, author's link or cursor crosses the workflow's history; it makes the read through the
// account's own LinkedIn account, logs it (`read_posts`, no object) and writes the page at `rawKey`,
// answering its key, count and whether a page follows. The caller reserves and settles the read
// (README.md "Read quota"); the definition bounds its attempts (POST_READ_ATTEMPTS).
import { json } from "node:stream/consumers";
import type { TenantClient } from "@whytide/db";
import { AppError, defineActivity, isAppError, workflowInput } from "@whytide/platform";
import {
  filesConfig,
  filesPort,
  getAdapter,
  linkedinPort,
  type PostsPage,
} from "@whytide/providers";
import { z } from "zod";
import { countAction, outcomeOf } from "../domain/action-log/log.ts";
import { parseInput } from "../domain/input.ts";
import { linkedin } from "../domain/provider.ts";
import { errors } from "../errors.ts";
import {
  type PostsFile,
  type PostsRead,
  type PostsRefused,
  postsFile,
  postsRequestFile,
  type ReadPosts,
  rawFileKey,
} from "../schemas/posts.ts";
import type { ActionOutcome } from "../schemas/quota.ts";
import { ID_MAX_CHARS, POST_READ_ATTEMPTS } from "./constants.ts";
import { type RefContext, withDecryptedRef } from "./decrypt.ts";
import { beforeRead, logRead } from "./reads.ts";

const postsInput = workflowInput.extend({
  accountId: z.string().min(1).max(ID_MAX_CHARS),
  requestKey: rawFileKey,
  rawKey: rawFileKey,
});
const { linkedin_account_disconnected, linkedin_not_found } = linkedinPort.errors;

/** The JSON at `key` in the workspace's folder. A read that fails throws, and the attempt fails. */
async function readJson(workspaceId: string, key: string): Promise<unknown> {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  return json((await files.get({ workspaceId, key })).body);
}

/**
 * The vendor's cursor of the page after the one whose file is at `after`; read_input_invalid naming
 * `after` for a file that is no page, or the last one.
 */
async function cursorAfter(workspaceId: string, after: string): Promise<string> {
  const page = postsFile.safeParse(await readJson(workspaceId, after));
  if (page.success && page.data.nextCursor !== null) return page.data.nextCursor;
  throw new AppError(errors.read_input_invalid, { details: { fields: ["after"] } });
}

/**
 * One page of a source's posts through the account's own LinkedIn account, the read in the action
 * log (no object: a phrase or an author is no person of ours), the page written at `rawKey`. A
 * request file off postsRequestFile is read_input_invalid naming its fields. An account not
 * connected, or an author gone or out of its sight, is a refusal; so is a stop, a pause or retry_at
 * ahead since its read was reserved, which makes no call (beforeRead). Any other error fails the
 * attempt. Each row carries `rawKey` as its call, so the attempts of one page count once.
 */
export async function readPosts(
  context: RefContext,
  input: ReadPosts,
): Promise<PostsRead | PostsRefused> {
  const { accountId, requestKey, rawKey } = input;
  const { workspaceId } = context;
  const { source, postedSince, after, limit } = parseInput(
    postsRequestFile,
    await readJson(workspaceId, requestKey),
  );
  const cursor = after === undefined ? undefined : await cursorAfter(workspaceId, after);
  const query = { postedSince: new Date(postedSince), cursor, limit };
  const adapter = await linkedin();
  const log = async (outcome: ActionOutcome, error?: unknown) => {
    const entry = { accountId, kind: "read_posts", count: 1, outcome, callRef: rawKey } as const;
    countAction(await context.tenant(() => logRead(entry, error)));
  };
  const call = (providerAccountRef: string): Promise<PostsPage> => {
    if (source.by === "phrase") {
      return adapter.searchPosts({ providerAccountRef, phrase: source.phrase, ...query });
    }
    if (source.by === "author") {
      return adapter.listAuthorPosts({ providerAccountRef, authorUrl: source.authorUrl, ...query });
    }
    return adapter.listOwnPosts({ providerAccountRef, ...query });
  };
  const read = (providerAccountRef: string) =>
    call(providerAccountRef).then(
      async (page) => {
        await log("ok");
        return page;
      },
      async (error: unknown) => {
        await log(outcomeOf(error), error);
        throw error;
      },
    );
  try {
    const held = await beforeRead(context, accountId);
    if (held !== null) return { refused: held };
    const page = await withDecryptedRef(context, accountId, read);
    const posts = page.posts.map((post) => ({ ...post, postedAt: post.postedAt.toISOString() }));
    const written: PostsFile = { posts, nextCursor: page.nextCursor };
    const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
    const body = JSON.stringify(written);
    const file = { workspaceId, key: rawKey, body, contentType: "application/json" };
    const { key } = await files.put(file);
    return { key, count: posts.length, more: page.nextCursor !== null };
  } catch (error) {
    const code = isAppError(error) ? error.code : undefined;
    if (code === linkedin_account_disconnected || code === linkedin_not_found)
      return { refused: code };
    throw error;
  }
}

export const postsActivities = {
  linkedin_read_posts: defineActivity<typeof postsInput, PostsRead | PostsRefused, TenantClient>({
    kind: "provider",
    attempts: POST_READ_ATTEMPTS,
    input: postsInput,
    run: (input, context) => readPosts(context, input),
  }),
};
