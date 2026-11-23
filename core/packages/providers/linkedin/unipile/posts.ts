// The post reads on Unipile (README.md "Covers", "Known differences"): searchPosts on the LinkedIn
// search in its posts category, sorted by date; listAuthorPosts on a member's or a company's posts
// by its id, a member's public id or a company's slug looked up first, in the same port call; and
// listOwnPosts on the account's own member id, as getAccountStatus reads it, then its posts. The
// search asks for the phrase in quotes, LinkedIn's exact phrase, and keeps only the posts whose
// text holds it, whatever the vendor matched. No route filters by date: the vendor lists newest
// first, the adapter keeps the posts at or after postedSince, and the vendor page whose last dated
// post is before postedSince ends the read. Each post goes through the port's schema: its link from
// its social id, in a form listPostEngagers reads, its excerpt cut (postExcerpt), its author a
// member or a company. A repost, an item off the shape and a search hit whose text does not hold
// the phrase are passed over, never logged. The cursor, signed and bound to the method and to the
// phrase, the author or the account (cursor.ts), holds the author's vendor id, the vendor's page
// size and the position: the vendor's cursor of the page being read, null for the first, and how
// many of its items are done.
import { z } from "zod";
import type { PortImplementation } from "../../_pattern/index.ts";
import { AUTHOR_PATHS, POSTS_PAGE_MAX } from "../constants.ts";
import {
  type LinkedinPost,
  type linkedinPort,
  linkedinPost,
  type PostAuthor,
  type PostsPage,
  postExcerpt,
} from "../port.ts";
import { type Client, type Method, notFound, offShape, providerError, segment } from "./client.ts";
import {
  COMPANY_ID,
  COMPANY_LINK,
  LINKEDIN_ACCOUNT,
  MAX_LOADS,
  MEMBER_LINK,
  PHRASE_QUOTE,
  POST_LINK,
  POST_TYPE,
  SEARCH_POSTS,
  SEARCH_POSTS_PAGE_MAX,
  SOCIAL_ID,
} from "./constants.ts";
import { type Cursors, cursorInvalid } from "./cursor.ts";

type Methods = Pick<
  PortImplementation<typeof linkedinPort>,
  "searchPosts" | "listAuthorPosts" | "listOwnPosts"
>;
type Query = {
  readonly postedSince: Date;
  readonly cursor?: string | undefined;
  readonly limit: number;
};

const ref = z.string().min(1).max(256);
/** Where a read is: the vendor's page size, its cursor of the page being read and the items done. */
const position = {
  size: z.int().min(1).max(POSTS_PAGE_MAX),
  at: z.tuple([z.string().min(1).nullable(), z.int().min(0)]),
};
const searchState = z.strictObject(position);
const authorState = z.strictObject({ id: ref, company: z.boolean(), ...position });
const ownState = z.strictObject({ id: ref, ...position });
type State = z.infer<typeof searchState>;

const list = z.object({ items: z.array(z.unknown()), cursor: z.string().min(1).nullish() });
/** A post as Unipile lists it: the fields the port maps, and nothing else of it. */
const vendorPost = z.object({
  type: z.string().nullish(),
  social_id: z.string().nullish(),
  text: z.string().nullish(),
  parsed_datetime: z.string().nullish(),
  is_repost: z.boolean().nullish(),
  author: z.object({
    id: z.string().nullish(),
    public_identifier: z.string().nullish(),
    name: z.string().nullish(),
    headline: z.string().nullish(),
    is_company: z.boolean().nullish(),
  }),
});
const member = z.object({ provider_id: ref });
const company = z.object({ id: ref });
const account = z.object({ type: z.string() });
/** The account's own member id in its details, when Unipile gives one, as index.ts reads it. */
const ownMember = z.object({ connection_params: z.object({ im: z.object({ id: ref }) }) });

export function posts(call: Client, cursors: Cursors): Methods {
  return {
    searchPosts: async ({ providerAccountRef, phrase, ...query }) => {
      const method = "searchPosts";
      const bound = [providerAccountRef, phrase];
      const state =
        query.cursor === undefined
          ? started(Math.min(query.limit, SEARCH_POSTS_PAGE_MAX))
          : resumed(searchState, cursors, method, query.cursor, bound, "phrase");
      const load = (cursor: string | null) =>
        call(method, {
          path: "/linkedin/search",
          query: pageQuery(providerAccountRef, state.size, cursor),
          body: { ...SEARCH_POSTS, keywords: quoted(phrase) },
        });
      const sign = (next: State) => cursors.sign(method, next, bound);
      return read({ method, load, holds: holding(phrase), query, state, sign });
    },
    listAuthorPosts: async ({ providerAccountRef, authorUrl, ...query }) => {
      const method = "listAuthorPosts";
      const bound = [providerAccountRef, authorUrl];
      const state =
        query.cursor === undefined
          ? { ...(await authorOf(call, providerAccountRef, authorUrl)), ...started(query.limit) }
          : resumed(authorState, cursors, method, query.cursor, bound, "author");
      const load = (cursor: string | null) =>
        call(method, {
          path: `/users/${segment(state.id, method)}/posts`,
          query: {
            ...pageQuery(providerAccountRef, state.size, cursor),
            ...(state.company ? { is_company: "true" } : {}),
          },
        });
      const sign = (next: State) => cursors.sign(method, { ...state, ...next }, bound);
      return read({ method, load, query, state, sign });
    },
    listOwnPosts: async ({ providerAccountRef, ...query }) => {
      const method = "listOwnPosts";
      const bound = [providerAccountRef];
      const state =
        query.cursor === undefined
          ? { id: await ownMemberOf(call, providerAccountRef), ...started(query.limit) }
          : resumed(ownState, cursors, method, query.cursor, bound, "account");
      const load = (cursor: string | null) =>
        call(method, {
          path: `/users/${segment(state.id, method)}/posts`,
          query: pageQuery(providerAccountRef, state.size, cursor),
        });
      const sign = (next: State) => cursors.sign(method, { ...state, ...next }, bound);
      return read({ method, load, query, state, sign });
    },
  };
}

/** The first page's state: the vendor's page size for the whole read, and its first page. */
const started = (size: number): State => ({ size, at: [null, 0] });

const pageQuery = (accountId: string, size: number, cursor: string | null) => ({
  account_id: accountId,
  limit: String(size),
  ...(cursor === null ? {} : { cursor }),
});

/** A cursor's state, signed for this method and bound to these values; else linkedin_input_invalid. */
function resumed<S extends z.ZodType>(
  schema: S,
  cursors: Cursors,
  method: Method,
  cursor: string,
  bound: readonly string[],
  of: "phrase" | "author" | "account",
): z.infer<S> {
  const state = schema.safeParse(cursors.open(method, cursor, bound));
  if (state.success) return state.data;
  throw cursorInvalid(method, of);
}

/** A member's id from their public id; a company's from its slug, unless the link holds the id. */
async function authorOf(call: Client, accountId: string, authorUrl: string) {
  const method = "listAuthorPosts";
  const path = URL.parse(authorUrl)?.pathname ?? "";
  const [, handle] = AUTHOR_PATHS.company.exec(path) ?? AUTHOR_PATHS.member.exec(path) ?? [];
  const id = decoded(handle);
  if (id === undefined) throw notFound(method);
  const query = { account_id: accountId };
  if (AUTHOR_PATHS.member.test(path)) {
    const answer = await call(method, {
      path: `/users/${segment(id, method)}`,
      query: { ...query, notify: "false" },
    });
    const found = member.safeParse(answer);
    if (!found.success) throw offShape(method);
    return { id: found.data.provider_id, company: false };
  }
  if (COMPANY_ID.test(id)) return { id, company: true };
  const answer = await call(method, { path: `/linkedin/company/${segment(id, method)}`, query });
  const found = company.safeParse(answer);
  if (!found.success) throw offShape(method);
  return { id: found.data.id, company: true };
}

/** The account's own member id, as getAccountStatus reads it. */
async function ownMemberOf(call: Client, accountId: string): Promise<string> {
  const method = "listOwnPosts";
  const answer = await call(method, { path: `/accounts/${segment(accountId, method)}` });
  const found = account.safeParse(answer);
  if (!found.success) throw offShape(method);
  if (found.data.type !== LINKEDIN_ACCOUNT) throw notFound(method);
  const id = ownMember.safeParse(answer).data?.connection_params.im.id;
  if (id === undefined) throw providerError(method, { reason: "an account without its member id" });
  return id;
}

const decoded = (handle: string | undefined) => {
  try {
    return handle === undefined ? undefined : decodeURIComponent(handle);
  } catch {
    return undefined;
  }
};

type Read = {
  readonly method: Method;
  /** The vendor's page at its cursor, null for the first. */
  readonly load: (cursor: string | null) => Promise<unknown>;
  /** A search's test of a post's text; an author's posts are all kept. */
  readonly holds?: (text: string) => boolean;
  readonly query: Query;
  readonly state: State;
  readonly sign: (next: State) => string;
};

/**
 * A page from the state's position: the vendor's pages loaded in turn, at most MAX_LOADS, each kept
 * post at or after postedSince taken until `limit`. The read ends on the vendor's last page and on
 * the page that reaches postedSince; past MAX_LOADS, the page answers what it holds, with a cursor.
 */
async function read({ method, load, holds, query, state, sign }: Read): Promise<PostsPage> {
  const since = query.postedSince.getTime();
  const taken: LinkedinPost[] = [];
  const answer = (next: State["at"] | null) => ({
    posts: taken.toSorted((a, b) => b.postedAt.getTime() - a.postedAt.getTime()),
    nextCursor: next === null ? null : sign({ size: state.size, at: next }),
  });
  let [cursor, done] = state.at;
  for (let loads = 0; loads < MAX_LOADS; loads++) {
    const page = pageOf(method, await load(cursor));
    const kept = page.items.map((item) => {
      const post = postOf(item, holds);
      return post !== undefined && post.postedAt.getTime() >= since ? post : undefined;
    });
    let at = done;
    for (; at < kept.length && taken.length < query.limit; at++) {
      const post = kept[at];
      if (post !== undefined) taken.push(post);
    }
    if (kept.slice(at).some((post) => post !== undefined)) return answer([cursor, at]);
    if (page.next === null || reaches(page.items, since)) return answer(null);
    [cursor, done] = [page.next, 0];
    if (taken.length === query.limit) break;
  }
  return answer([cursor, done]);
}

function pageOf(method: Method, body: unknown) {
  const parsed = list.safeParse(body);
  if (!parsed.success) throw providerError(method, { reason: "a posts page without items" });
  return { items: parsed.data.items, next: parsed.data.cursor ?? null };
}

/** The page reaches postedSince when its last dated post, a repost aside, is before it. */
function reaches(items: readonly unknown[], since: number): boolean {
  const dates = items.flatMap((item) => {
    const post = vendorPost.safeParse(item).data;
    const at = Date.parse(post?.parsed_datetime ?? "");
    return post === undefined || post.is_repost === true || Number.isNaN(at) ? [] : [at];
  });
  const last = dates.at(-1);
  return last !== undefined && last < since;
}

/** The port's post, or undefined for an item it cannot hold or that the read passes over. */
function postOf(item: unknown, holds?: (text: string) => boolean): LinkedinPost | undefined {
  const parsed = vendorPost.safeParse(item);
  if (!parsed.success) return undefined;
  const { type, social_id, text, parsed_datetime, is_repost, author } = parsed.data;
  if (is_repost === true || (type != null && type !== POST_TYPE)) return undefined;
  const social = SOCIAL_ID.exec(social_id ?? "");
  const postedAt = Date.parse(parsed_datetime ?? "");
  const by = authorFrom(author);
  if (social === null || Number.isNaN(postedAt) || by === undefined) return undefined;
  if (holds !== undefined && !holds(text ?? "")) return undefined;
  const post = linkedinPost.safeParse({
    postUrl: `${POST_LINK}urn:li:${social[1]}:${social[2]}`,
    postedAt: new Date(postedAt),
    excerpt: postExcerpt(text ?? ""),
    author: by,
  });
  return post.success ? post.data : undefined;
}

/** A post's author: a company page by its slug or id, else a member by their public id or id. */
function authorFrom(author: z.infer<typeof vendorPost>["author"]): PostAuthor | undefined {
  const { id, public_identifier: handle, name, is_company: isCompany } = author;
  const page = handle || id;
  if (!page) return undefined;
  if (isCompany === true) {
    return {
      kind: "company",
      companyUrl: `${COMPANY_LINK}${encodeURIComponent(page)}`,
      name: name ?? "",
    };
  }
  if (!id) return undefined;
  return {
    kind: "member",
    providerMemberRef: id,
    profileUrl: `${MEMBER_LINK}${encodeURIComponent(page)}`,
    name: name ?? "",
    headline: author.headline ?? "",
  };
}

/** The phrase as LinkedIn's exact phrase: in quotes, a quote inside it a space. */
const quoted = (phrase: string) =>
  `${PHRASE_QUOTE}${phrase.replaceAll(PHRASE_QUOTE, " ")}${PHRASE_QUOTE}`;

/**
 * A search's test that a post's text holds the exact phrase, in any case, its words apart by any
 * spaces, and neither a letter nor a digit on either side: Unipile's search may match the words
 * alone (README.md "Known differences").
 */
function holding(phrase: string): (text: string) => boolean {
  const words = phrase
    .split(/\s+/u)
    .filter((word) => word !== "")
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${words.join("\\s+")}(?![\\p{L}\\p{N}])`, "iu");
  return (text) => pattern.test(text);
}
