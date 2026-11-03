// listPostEngagers on Unipile (README.md "Covers"): a post's reactions and its comments, two lists
// of the vendor's, merged newest first by engagedAt into the port's Engager rows. A comment carries
// its date. A reaction carries none at Unipile, so it takes the time its listing started: it sorts
// above the comments written before, and a cursor read again gives the same page. The cursor holds
// that time, the post's social id and, for each list, the vendor's cursor of the page being read
// with how many of its items are done, or null once the list is read to the end.
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { type Engager, linkedinEngager, linkedinPort } from "../port.ts";
import { type Client, notFound, providerError, segment } from "./client.ts";
import { ACTIVITY, POST_PATHS } from "./constants.ts";

type Input = {
  readonly providerAccountRef: string;
  readonly postUrl: string;
  readonly cursor?: string | undefined;
  readonly limit: number;
};
type Page = { readonly items: readonly (Engager | undefined)[]; readonly next: string | null };

const METHOD = "listPostEngagers";
/** Vendor pages one call may load, both lists together: a vendor's cursor that loops stops here. */
const MAX_LOADS = 10;
const position = z.tuple([z.string().min(1).nullable(), z.int().min(0)]).nullable();
const cursorState = z.strictObject({
  post: z.string().min(1),
  social: z.string().min(1).max(256),
  at: z.int().min(0),
  reactions: position,
  comments: position,
});
type State = z.infer<typeof cursorState>;
type Position = z.infer<typeof position>;

const list = z.object({
  items: z.array(z.unknown()),
  cursor: z.string().min(1).nullish(),
  paging: z.object({ cursor: z.string().min(1).nullish() }).nullish(),
});
const reactionItem = z.object({
  author: z.object({
    id: z.string(),
    name: z.string().nullish(),
    headline: z.string().nullish(),
    profile_url: z.string().nullish(),
  }),
});
const commentItem = z.object({
  author: z.string().nullish(),
  author_details: z.object({
    id: z.string(),
    headline: z.string().nullish(),
    profile_url: z.string().nullish(),
  }),
  date: z.string(),
  text: z.string().nullish(),
});

export async function listPostEngagers(call: Client, now: () => number, input: Input) {
  const post = postIdOf(input.postUrl);
  if (post === undefined) throw notFound(METHOD);
  const state =
    input.cursor === undefined
      ? await started(call, input, post, now())
      : resumed(input.cursor, post);
  let loads = 0;
  const load = async (list: "reactions" | "comments", cursor: string | null) => {
    if (++loads > MAX_LOADS) throw providerError(METHOD, { reason: "too many vendor pages" });
    const query = {
      account_id: input.providerAccountRef,
      limit: String(input.limit),
      ...(list === "comments" ? { sort_by: "MOST_RECENT" } : {}),
      ...(cursor === null ? {} : { cursor }),
    };
    const path = `/posts/${segment(state.social, METHOD)}/${list}`;
    return pageOf(await call(METHOD, { path, query }), list, state.at);
  };
  const reactions = feed((cursor) => load("reactions", cursor), state.reactions);
  const comments = feed((cursor) => load("comments", cursor), state.comments);
  const engagers: Engager[] = [];
  while (engagers.length < input.limit) {
    const [reaction, comment] = [await reactions.head(), await comments.head()];
    if (reaction === undefined && comment === undefined) break;
    const first =
      reaction !== undefined &&
      (comment === undefined || reaction.engagedAt.getTime() >= comment.engagedAt.getTime());
    engagers.push(first ? reaction : (comment as Engager));
    (first ? reactions : comments).take();
  }
  const next = { ...state, reactions: reactions.position(), comments: comments.position() };
  const done = next.reactions === null && next.comments === null;
  return { engagers, nextCursor: done ? null : cursorOf(next) };
}

/**
 * The post's id as Unipile's GET /posts/{id} takes it, from a link of a POST_PATHS form: an
 * activity's number, a share's or a ugcPost's URN; undefined for any other link.
 */
function postIdOf(postUrl: string): string | undefined {
  const path = URL.parse(postUrl)?.pathname ?? "";
  for (const pattern of POST_PATHS) {
    const [, kind, id] = pattern.exec(path) ?? [];
    if (kind === undefined || id === undefined) continue;
    return kind === ACTIVITY ? id : `urn:li:${kind}:${id}`;
  }
  return undefined;
}

/** The first page: the post's social id, which the lists take, and the listing's time. */
async function started(call: Client, input: Input, post: string, at: number): Promise<State> {
  const path = `/posts/${segment(post, METHOD)}`;
  const query = { account_id: input.providerAccountRef };
  const found = z
    .object({ social_id: z.string().min(1).max(256) })
    .safeParse(await call(METHOD, { path, query }));
  if (!found.success) throw providerError(METHOD, { reason: "a post without its social id" });
  return { post, social: found.data.social_id, at, reactions: [null, 0], comments: [null, 0] };
}

function resumed(cursor: string, post: string): State {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    decoded = undefined;
  }
  const state = cursorState.safeParse(decoded);
  if (state.success && state.data.post === post) return state.data;
  const reason = "a cursor the adapter did not give for this post";
  throw new AppError(linkedinPort.codes.input, { details: { method: METHOD, reason } });
}

const cursorOf = (state: State) => Buffer.from(JSON.stringify(state)).toString("base64url");

/** One of the post's lists from a position: its next engager, the vendor's pages loaded as needed. */
function feed(load: (cursor: string | null) => Promise<Page>, start: Position) {
  let at = start;
  let page: Page | undefined;
  /** The position, moved to the next page once this one is read to its end. */
  const settled = (): Position => {
    if (at === null || page === undefined || at[1] < page.items.length) return at;
    return page.next === null ? null : [page.next, at[1] - page.items.length];
  };
  return {
    async head(): Promise<Engager | undefined> {
      while (at !== null) {
        page ??= await load(at[0]);
        const moved = settled();
        if (moved !== at) {
          [at, page] = [moved, undefined];
          continue;
        }
        const item = page.items[at[1]];
        if (item) return item;
        at = [at[0], at[1] + 1]; // an item the port cannot hold: passed over
      }
      return undefined;
    },
    take(): void {
      if (at !== null) at = [at[0], at[1] + 1];
    },
    position: settled,
  };
}

function pageOf(body: unknown, kind: "reactions" | "comments", at: number): Page {
  const parsed = list.safeParse(body);
  if (!parsed.success) throw providerError(METHOD, { reason: `a ${kind} page without items` });
  const { items, cursor, paging } = parsed.data;
  const engager = kind === "reactions" ? reactionOf : commentOf;
  return { items: items.map((item) => engager(item, at)), next: cursor ?? paging?.cursor ?? null };
}

function reactionOf(item: unknown, at: number): Engager | undefined {
  const parsed = reactionItem.safeParse(item);
  if (!parsed.success) return undefined;
  const { id, name, headline, profile_url } = parsed.data.author;
  return engagerOf({
    providerMemberRef: id,
    profileUrl: profile_url,
    name: name ?? "",
    headline: headline ?? "",
    reaction: "like",
    engagedAt: new Date(at),
  });
}

function commentOf(item: unknown, at: number): Engager | undefined {
  const parsed = commentItem.safeParse(item);
  if (!parsed.success) return undefined;
  const { author, author_details: details, date, text } = parsed.data;
  const written = Date.parse(date);
  return engagerOf({
    providerMemberRef: details.id,
    profileUrl: details.profile_url,
    name: author ?? "",
    headline: details.headline ?? "",
    reaction: "comment",
    commentText: text ?? "",
    engagedAt: new Date(Number.isNaN(written) ? at : written),
  });
}

/** Through the port's schema, which keeps business fields only; undefined for one it cannot hold. */
function engagerOf(mapped: Record<string, unknown>): Engager | undefined {
  const parsed = linkedinEngager.safeParse(mapped);
  return parsed.success ? parsed.data : undefined;
}
