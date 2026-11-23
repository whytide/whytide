// The LinkedIn port's contract (README.md "The contract suite"): what every adapter does, run by
// each adapter's tests/contract.test.ts with a LinkedinWorld, the adapter's side of the cases: how
// a user connects through a hosted link, a post and a profile the account can read (a 1st-degree
// connection's too, connect-already-connected), the vendor's
// signed webhooks and, when the vendor can be made to send one, its rate limit; for the send cases,
// a member to invite or a relation to message, and a disconnected account; for the event cases, a
// signed event of each kind (README.md "Events"); for the post cases, the account's sources of posts
// (README.md "Posts"); for the company case, a company page and what getCompany answers for it
// (README.md "Company pages"); for the contact case, a 1st-degree connection's member ref and the
// addresses getContactEmails answers for it (README.md "What the port will never have", the owner's
// exception of 2026-11-13). The fake's world seeds all of it; a vendor's world points at its sandbox, and
// a case skips where it gives no recipient, no events, none of a kind the vendor never sends or no
// posts. A run sends at most one invitation, withdrawn at once, and one message.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { isAppError } from "@whytide/platform";
import type { PortInstance } from "../_pattern/index.ts";
import type { ContractCases } from "../testing/index.ts";
import { CONTACT_EMAILS_MAX, POST_EXCERPT_MAX_CHARS } from "./constants.ts";
import {
  type HostedAuthLink,
  LINKEDIN_DISCONNECT_REASONS,
  LINKEDIN_WEBHOOK_KINDS,
  type LinkedinCompany,
  type LinkedinWebhook,
  type LinkedinWebhookEvent,
  type linkedinPort,
  type PendingInvite,
  type PostsPage,
  type Profile,
  postExcerpt,
} from "./port.ts";

type Linkedin = PortInstance<typeof linkedinPort>;
type Kind = LinkedinWebhookEvent["kind"];
/** alpha's account events, which every world signs. */
type AccountEvent = Extract<
  LinkedinWebhookEvent,
  { kind: "account.connected" | "account.disconnected" | "account.credentials_required" }
>;
/** A signed event of the world's, for the event cases. */
export type LinkedinWorldEvent = {
  /** The request as the vendor delivers it, signed. */
  readonly webhook: LinkedinWebhook;
  /** The same request signed otherwise: a wrong signature or a wrong secret. */
  readonly forged: LinkedinWebhook;
  /** What parseWebhook gives for it. */
  readonly expected: LinkedinWebhookEvent;
};

/** Where every case's hosted link sends the user back. */
export const RETURN_URLS = {
  successUrl: "https://app.whytide.test/w/acme/linkedin/connected",
  failureUrl: "https://app.whytide.test/w/acme/linkedin/failed",
} as const;
/** How far a vendor's clock may sit from ours, for the times a send answers. */
const SKEW_MS = 60_000;
/** A post no account can see. */
const UNKNOWN_POST = "https://www.linkedin.com/feed/update/urn:li:activity:1000000000000000000/";
/** Pages of pending invitations or of posts read at most: a cursor that loops stops here. */
const PAGES_AT_MOST = 50;
/** Authors no account can see: a member's page and a company's. */
/** An address's form, as a case checks it: a local part, an at sign, a dotted domain. */
const EMAIL_FORM = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UNKNOWN_AUTHORS = [
  "https://www.linkedin.com/in/whytide-contract-no-such-member-0000",
  "https://www.linkedin.com/company/whytide-contract-no-such-company-0000",
] as const;
/** A company page's keys, sorted: these at most, `companyUrl`, `name` and `fetchedAt` always. */
const COMPANY_KEYS = [
  "companyUrl",
  "description",
  "employeeCount",
  "employeeRange",
  "fetchedAt",
  "foundedYear",
  "headquartersCountry",
  "industry",
  "name",
  "website",
];
/** A post's keys, and its author's by kind, sorted: exactly these. */
const POST_KEYS = ["author", "excerpt", "postUrl", "postedAt"];
const AUTHOR_KEYS = {
  member: ["headline", "kind", "name", "profileUrl", "providerMemberRef"],
  company: ["companyUrl", "kind", "name"],
};

/** A source of posts: its read's own input, and how many posts it gives at or after postedSince. */
type PostSource<I> = I & { readonly count: number };
/**
 * The account's sources of posts, for the post cases. Each holds at least five posts at or after
 * `postedSince`, so that a page of a third of them makes three pages, and may hold older ones; an
 * absent source, and its case skips.
 */
export type LinkedinWorldPosts = {
  readonly postedSince: Date;
  readonly search?: PostSource<{ readonly phrase: string }>;
  readonly member?: PostSource<{ readonly authorUrl: string }>;
  readonly company?: PostSource<{ readonly authorUrl: string }>;
  readonly own?: PostSource<object>;
  /** An author whose newest post is longer than an excerpt, and that post's whole text. */
  readonly long?: { readonly authorUrl: string; readonly text: string };
};

export type LinkedinWorld = {
  /** The user connects their own account through the link: the vendor's account.connected webhook. */
  connect(link: HostedAuthLink, t: TestContext): Promise<LinkedinWebhook>;
  /** A post the account can read, with at least three engagers, and how many it has. */
  post(): Promise<{ readonly postUrl: string; readonly engagers: number }>;
  /** A profile the account can read and, when the world knows it, what getProfile returns. */
  profile(): Promise<{
    readonly profileUrl: string;
    readonly expected?: Omit<Profile, "fetchedAt">;
  }>;
  /**
   * The profile of a 1st-degree connection of the account; absent, or undefined for what the world
   * cannot give, and the case skips.
   */
  connection?(providerAccountRef: string): Promise<{ readonly profileUrl: string } | undefined>;
  /** The vendor's webhook for the event, signed as the vendor signs it, or forged: signed otherwise. */
  webhook(event: AccountEvent, options?: { forged?: boolean }): Promise<LinkedinWebhook>;
  /**
   * A new signed event of the kind on every call, as the vendor delivers it; for `ignored`, of a type
   * the port does not know; undefined for a kind the vendor never sends (Unipile has no
   * `account.status`), whose case skips. Absent, and the event cases skip.
   */
  event?(kind: Kind): Promise<LinkedinWorldEvent | undefined>;
  /** The vendor's next answer is a rate limit; absent when the vendor cannot be made to send one. */
  rateLimitNext?(): void;
  /**
   * A member the account may invite: no relation, no invitation pending; with `relation`, a member
   * the account may message, a relation already. Absent, or undefined for what the world cannot
   * give, and the send case skips; on a vendor, an account its owner controls (beta-p0-030).
   */
  recipient?(
    providerAccountRef: string,
    options?: { readonly relation?: boolean },
  ): Promise<string | undefined>;
  /** A disconnected account's ref; absent, and the disconnected-account case skips. */
  disconnected?(): Promise<string>;
  /** The connected account's sources of posts; absent or undefined, and the post cases skip. */
  posts?(providerAccountRef: string): Promise<LinkedinWorldPosts | undefined>;
  /**
   * A company page the account can read and, when the world knows it, what getCompany answers for
   * it; absent, and the company cases skip.
   */
  company?(): Promise<{
    readonly companyUrl: string;
    readonly expected?: Omit<LinkedinCompany, "fetchedAt">;
  }>;
  /**
   * A 1st-degree connection of the account who shows email addresses in "Contact info", a member
   * who shows none, and, when the world knows them, the addresses getContactEmails answers for the
   * first; absent, and the contact case skips (gamma-en-087).
   */
  contactEmails?(providerAccountRef: string): Promise<{
    readonly memberRef: string;
    readonly withoutRef: string;
    readonly expected?: readonly string[];
  }>;
};

/** The port code, and nothing of `absent` (a body's content) in its message or details. */
const failsWith = (code: string, absent?: string) => (error: unknown) => {
  assert.ok(isAppError(error) && error.code === code, `${code}, not ${String(error)}`);
  if (absent) assert.ok(!JSON.stringify([error.message, error.details]).includes(absent));
  return true;
};

/** An account connected through a hosted link: the link and the parsed account.connected webhook. */
async function connected(linkedin: Linkedin, world: LinkedinWorld, t: TestContext) {
  const link = await linkedin.createHostedAuthLink({ ...RETURN_URLS, expiresInMin: 30 });
  const event = await linkedin.parseWebhook(await world.connect(link, t));
  assert.ok(event.kind === "account.connected", `account.connected, not ${event.kind}`);
  return { link, event };
}

/** The refs and the text an event carries: none may appear in a refusal of it. */
const valuesOf = (event: LinkedinWebhookEvent): string[] =>
  Object.entries(event).flatMap(([key, value]) =>
    key === "kind" || key === "status" ? [] : [value].flat().filter((v) => typeof v === "string"),
  );
/** A person event's key; an account event and `ignored` carry none. */
const keyOf = (event: LinkedinWebhookEvent) => ("eventKey" in event ? event.eventKey : undefined);

/** One case per kind: signed, the event parses to its shape; forged or unsigned, it is refused. */
const eventCases = (world: LinkedinWorld): ContractCases<typeof linkedinPort> =>
  Object.fromEntries(
    LINKEDIN_WEBHOOK_KINDS.map((kind) => [
      `${kind}: a signed event parses to its shape; forged or unsigned, linkedin_webhook_invalid`,
      async (linkedin: Linkedin, t: TestContext) => {
        if (!world.event) return t.skip("no signed events in this world");
        const made = await world.event(kind);
        if (made === undefined) return t.skip(`no ${kind} event from this vendor`);
        const { webhook, forged, expected } = made;
        assert.equal(expected.kind, kind);
        assert.deepEqual(await linkedin.parseWebhook(webhook), expected);
        const unsigned = { headers: {}, rawBody: webhook.rawBody };
        for (const refused of [forged, unsigned]) {
          await assert.rejects(linkedin.parseWebhook(refused), (error: unknown) => {
            failsWith("linkedin_webhook_invalid")(error);
            const said = JSON.stringify([
              (error as Error).message,
              isAppError(error) && error.details,
            ]);
            const leaked = valuesOf(expected).filter((value) => said.includes(value));
            assert.deepEqual(leaked, [], "nothing of the body in the refusal");
            return true;
          });
        }
      },
    ]),
  );

/** A time a send answers: from the call's start to now, give or take a vendor's clock. */
const answeredAt = (at: Date, start: number) =>
  at.getTime() >= start - SKEW_MS && at.getTime() <= Date.now() + SKEW_MS;

/** Every pending invitation of the account's, over every page. */
async function pendingInvites(linkedin: Linkedin, providerAccountRef: string) {
  const invites: PendingInvite[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages === 0 || cursor !== null; pages++) {
    assert.ok(pages < PAGES_AT_MOST, "listPendingInvites ends");
    const page = await linkedin.listPendingInvites({
      providerAccountRef,
      ...(cursor ? { cursor } : {}),
    });
    invites.push(...page.invites);
    cursor = page.nextCursor;
  }
  return invites;
}

/** A post read, its query aside. */
type PostRead = (query: {
  readonly postedSince: Date;
  readonly limit: number;
  readonly cursor?: string;
}) => Promise<PostsPage>;
/** The post cases' reads, one case each. */
const POST_READS = [
  "searchPosts",
  "listAuthorPosts, a member's",
  "listAuthorPosts, a company page's",
  "listOwnPosts",
] as const;
type PostReads = {
  readonly [N in (typeof POST_READS)[number]]?:
    | { readonly count: number; readonly read: PostRead }
    | undefined;
};

/** The reads of the world's sources of posts; none where the world gives no source. */
function postReads(
  linkedin: Linkedin,
  providerAccountRef: string,
  { search, member, company, own }: LinkedinWorldPosts,
): PostReads {
  const by =
    (authorUrl: string): PostRead =>
    (query) =>
      linkedin.listAuthorPosts({ providerAccountRef, authorUrl, ...query });
  return {
    searchPosts: search && {
      count: search.count,
      read: (query) =>
        linkedin.searchPosts({ providerAccountRef, phrase: search.phrase, ...query }),
    },
    "listAuthorPosts, a member's": member && { count: member.count, read: by(member.authorUrl) },
    "listAuthorPosts, a company page's": company && {
      count: company.count,
      read: by(company.authorUrl),
    },
    listOwnPosts: own && {
      count: own.count,
      read: (query) => linkedin.listOwnPosts({ providerAccountRef, ...query }),
    },
  };
}

/** Every page of a post read, from the first: each page's cursor reads the next. */
async function pagesOf(read: (cursor?: string) => Promise<PostsPage>) {
  const pages = [await read()];
  for (let page = pages[0]; page?.nextCursor && pages.length < PAGES_AT_MOST; ) {
    page = await read(page.nextCursor);
    pages.push(page);
  }
  return pages;
}

/** The connected account and its sources of posts, or the case skips. */
async function withPosts(linkedin: Linkedin, world: LinkedinWorld, t: TestContext) {
  if (!world.posts) return undefined;
  const { providerAccountRef } = (await connected(linkedin, world, t)).event;
  const posts = await world.posts(providerAccountRef);
  return posts && { providerAccountRef, posts };
}

/** One case per read: three pages newest first, a stable cursor, nothing before postedSince. */
const postCases = (world: LinkedinWorld): ContractCases<typeof linkedinPort> =>
  Object.fromEntries(
    POST_READS.map((name) => [
      `${name} posts page newest first over three pages with a stable cursor, none before postedSince`,
      async (linkedin: Linkedin, t: TestContext) => {
        const found = await withPosts(linkedin, world, t);
        const source = found && postReads(linkedin, found.providerAccountRef, found.posts)[name];
        if (!found || !source) return t.skip(`no posts for ${name} in this world`);
        const { postedSince } = found.posts;
        const limit = Math.ceil(source.count / 3);
        const read = (cursor?: string) =>
          source.read({ postedSince, limit, ...(cursor ? { cursor } : {}) });
        const pages = await pagesOf(read);
        assert.equal(pages.length, 3, "three pages");
        assert.equal(pages.at(-1)?.nextCursor, null, "the page that reaches postedSince ends");
        const all = pages.flatMap((page) => page.posts);
        assert.equal(all.length, source.count);
        assert.equal(new Set(all.map(({ postUrl }) => postUrl)).size, all.length, "each once");
        const times = all.map(({ postedAt }) => postedAt.getTime());
        assert.deepEqual(
          times,
          times.toSorted((a, b) => b - a),
          "newest first",
        );
        assert.ok(
          times.every((time) => time >= postedSince.getTime()),
          "none before postedSince",
        );
        assert.deepEqual(await read(pages[0]?.nextCursor ?? undefined), pages[1], "read again");
      },
    ]),
  );

export const linkedinCases = (world: LinkedinWorld): ContractCases<typeof linkedinPort> => ({
  ...eventCases(world),
  ...postCases(world),
  "listAuthorPosts gives a member's posts by the member and a company page's by the company, each author with exactly its kind's fields":
    async (linkedin, t) => {
      const found = await withPosts(linkedin, world, t);
      const { member, company, postedSince } = found?.posts ?? {};
      if (!found || !member || !company || !postedSince) return t.skip("no authors in this world");
      for (const [kind, { authorUrl }] of [
        ["member", member],
        ["company", company],
      ] as const) {
        const { posts } = await linkedin.listAuthorPosts({
          providerAccountRef: found.providerAccountRef,
          authorUrl,
          postedSince,
          limit: 10,
        });
        assert.ok(posts.length > 0, `${kind}: posts`);
        for (const post of posts) {
          assert.deepEqual(Object.keys(post).toSorted(), POST_KEYS);
          assert.equal(post.author.kind, kind);
          assert.deepEqual(Object.keys(post.author).toSorted(), AUTHOR_KEYS[kind]);
        }
      }
    },
  "an excerpt is the post's first 500 characters, an emoji at the edge whole or left out": async (
    linkedin,
    t,
  ) => {
    const found = await withPosts(linkedin, world, t);
    const long = found?.posts.long;
    if (!found || !long) return t.skip("no long post in this world");
    const { posts } = await linkedin.listAuthorPosts({
      providerAccountRef: found.providerAccountRef,
      authorUrl: long.authorUrl,
      postedSince: new Date(0),
      limit: 1,
    });
    assert.ok(Array.from(long.text).length > POST_EXCERPT_MAX_CHARS, "a post longer than that");
    const excerpt = posts[0]?.excerpt;
    assert.ok(excerpt !== undefined, "the long post");
    assert.ok(Array.from(excerpt).length <= POST_EXCERPT_MAX_CHARS && excerpt.isWellFormed());
    assert.equal(excerpt, postExcerpt(long.text));
  },
  "an unknown author is linkedin_not_found, a member's page or a company's": async (
    linkedin,
    t,
  ) => {
    const found = await withPosts(linkedin, world, t);
    if (!found) return t.skip("no posts in this world");
    for (const authorUrl of UNKNOWN_AUTHORS) {
      await assert.rejects(
        linkedin.listAuthorPosts({
          providerAccountRef: found.providerAccountRef,
          authorUrl,
          postedSince: found.posts.postedSince,
          limit: 10,
        }),
        failsWith("linkedin_not_found"),
      );
    }
  },
  "getCompany returns a company page's business fields and no other": async (linkedin, t) => {
    if (!world.company) return t.skip("no company page in this world");
    const { providerAccountRef } = (await connected(linkedin, world, t)).event;
    const { companyUrl, expected } = await world.company();
    const before = Date.now();
    const { fetchedAt, ...company } = await linkedin.getCompany({ providerAccountRef, companyUrl });
    assert.ok(fetchedAt.getTime() >= before - 1000 && fetchedAt.getTime() <= Date.now());
    const keys = Object.keys(company).toSorted();
    assert.ok(
      keys.every((key) => COMPANY_KEYS.includes(key)),
      keys.join(),
    );
    assert.ok(company.name !== undefined && company.companyUrl !== undefined);
    if (expected) assert.deepEqual(company, expected);
  },
  "an unknown company page is linkedin_not_found": async (linkedin, t) => {
    if (!world.company) return t.skip("no company page in this world");
    const { providerAccountRef } = (await connected(linkedin, world, t)).event;
    await assert.rejects(
      linkedin.getCompany({ providerAccountRef, companyUrl: UNKNOWN_AUTHORS[1] }),
      failsWith("linkedin_not_found"),
    );
  },
  "getContactEmails answers email addresses only, lower case, each once, three at most; a member who shows none, none":
    async (linkedin, t) => {
      if (!world.contactEmails) return t.skip("no contact info in this world");
      const { providerAccountRef } = (await connected(linkedin, world, t)).event;
      const { memberRef, withoutRef, expected } = await world.contactEmails(providerAccountRef);
      const answer = await linkedin.getContactEmails({ providerAccountRef, memberRef });
      assert.deepEqual(Object.keys(answer), ["emails"]);
      const { emails } = answer;
      assert.ok(emails.length <= CONTACT_EMAILS_MAX, emails.join());
      assert.equal(new Set(emails).size, emails.length);
      for (const address of emails) {
        assert.equal(address, address.toLowerCase());
        assert.ok(EMAIL_FORM.test(address), "an address");
      }
      if (expected) assert.deepEqual(emails, expected);
      const none = await linkedin.getContactEmails({ providerAccountRef, memberRef: withoutRef });
      assert.deepEqual(none, { emails: [] });
    },
  "an event delivered twice gives the same eventKey; two messages give two keys": async (
    linkedin,
    t,
  ) => {
    const event = world.event?.bind(world);
    if (!event) return t.skip("no signed events in this world");
    const signed = async (kind: "invite.accepted" | "message.received") => {
      const made = await event(kind);
      assert.ok(made, `a signed ${kind}`);
      return made.webhook;
    };
    for (const kind of ["invite.accepted", "message.received"] as const) {
      const webhook = await signed(kind);
      const first = keyOf(await linkedin.parseWebhook(webhook));
      assert.ok(first, `${kind}: an eventKey`);
      assert.equal(keyOf(await linkedin.parseWebhook(webhook)), first, `${kind} redelivered`);
    }
    const message = async () =>
      keyOf(await linkedin.parseWebhook(await signed("message.received")));
    assert.notEqual(await message(), await message(), "two messages, two keys");
  },
  "getAccountStatus answers the account's own member id, the same on every call, or null": async (
    linkedin,
    t,
  ) => {
    const { providerAccountRef } = (await connected(linkedin, world, t)).event;
    const { memberRef } = await linkedin.getAccountStatus(providerAccountRef);
    assert.equal((await linkedin.getAccountStatus(providerAccountRef)).memberRef, memberRef);
  },
  "a hosted link connects the user's account: the webhook names it and its status is connected":
    async (linkedin, t) => {
      const before = Date.now();
      const { link, event } = await connected(linkedin, world, t);
      const expiresAt = link.expiresAt.getTime();
      assert.ok(expiresAt > before && expiresAt <= Date.now() + 30 * 60_000, "within 30 minutes");
      const { providerAccountRef } = event;
      const connectedEvent = { kind: "account.connected", providerAccountRef };
      assert.deepEqual(event, { ...connectedEvent, providerRef: link.providerRef });
      assert.equal((await linkedin.getAccountStatus(providerAccountRef)).status, "connected");
    },
  "listPostEngagers pages through every engager once, over three pages, with a stable cursor":
    async (linkedin, t) => {
      const { providerAccountRef } = (await connected(linkedin, world, t)).event;
      const { postUrl, engagers } = await world.post();
      const limit = Math.ceil(engagers / 3);
      const read = (cursor: string | null) =>
        linkedin.listPostEngagers({
          providerAccountRef,
          postUrl,
          limit,
          ...(cursor ? { cursor } : {}),
        });
      const pages = [await read(null)];
      for (let page = pages[0]; page?.nextCursor && pages.length < 10; ) {
        page = await read(page.nextCursor);
        pages.push(page);
      }
      assert.equal(pages.length, 3);
      assert.equal(pages.at(-1)?.nextCursor, null);
      const all = pages.flatMap((page) => page.engagers);
      const keys = all.map(
        (e) => `${e.providerMemberRef} ${e.reaction} ${e.engagedAt.toISOString()}`,
      );
      assert.equal(all.length, engagers);
      assert.equal(new Set(keys).size, engagers, "every engager once");
      assert.deepEqual(
        await read(pages[0]?.nextCursor ?? null),
        pages[1],
        "the cursor reads again",
      );
    },
  "listPostEngagers gives the newest engagers first, by engagedAt, on every page": async (
    linkedin,
    t,
  ) => {
    const { providerAccountRef } = (await connected(linkedin, world, t)).event;
    const { postUrl, engagers } = await world.post();
    const times: number[] = [];
    let cursor: string | null = null;
    do {
      const page = await linkedin.listPostEngagers({
        providerAccountRef,
        postUrl,
        limit: Math.ceil(engagers / 3),
        ...(cursor ? { cursor } : {}),
      });
      times.push(...page.engagers.map(({ engagedAt }) => engagedAt.getTime()));
      cursor = page.nextCursor;
    } while (cursor !== null && times.length <= engagers);
    assert.equal(times.length, engagers);
    assert.deepEqual(
      times,
      times.toSorted((a, b) => b - a),
      "newest first",
    );
  },
  "getProfile returns the profile's business fields": async (linkedin, t) => {
    const { providerAccountRef } = (await connected(linkedin, world, t)).event;
    const { profileUrl, expected } = await world.profile();
    const before = Date.now();
    const { fetchedAt, ...profile } = await linkedin.getProfile({ providerAccountRef, profileUrl });
    assert.ok(fetchedAt.getTime() >= before - 1000 && fetchedAt.getTime() <= Date.now());
    if (expected) assert.deepEqual(profile, expected);
  },
  "getProfile says a 1st-degree connection is one: connected true": async (linkedin, t) => {
    if (!world.connection) return t.skip("no connection's profile in this world");
    const { providerAccountRef } = (await connected(linkedin, world, t)).event;
    const found = await world.connection(providerAccountRef);
    if (!found) return t.skip("no connection's profile in this world");
    const profile = await linkedin.getProfile({ providerAccountRef, profileUrl: found.profileUrl });
    assert.equal(profile.connected, true);
  },
  "a signed webhook parses; a forged or unsigned one is linkedin_webhook_invalid": async (
    linkedin,
  ) => {
    const event = { kind: "account.disconnected", providerAccountRef: "contract-account" } as const;
    const webhook = await world.webhook(event);
    assert.deepEqual(await linkedin.parseWebhook(webhook), event);
    const forged = await world.webhook(event, { forged: true });
    for (const refused of [forged, { headers: {}, rawBody: webhook.rawBody }]) {
      await assert.rejects(
        linkedin.parseWebhook(refused),
        failsWith("linkedin_webhook_invalid", "contract-account"),
      );
    }
  },
  "a rate limit is linkedin_rate_limited with retryAfterSec": async (linkedin, t) => {
    if (!world.rateLimitNext) return t.skip("the vendor's rate limit: the adapter's mapping tests");
    world.rateLimitNext();
    await assert.rejects(linkedin.getAccountStatus("contract-account"), (error: unknown) => {
      failsWith("linkedin_rate_limited")(error);
      const retryAfterSec = (error as { details?: { retryAfterSec?: unknown } }).details
        ?.retryAfterSec;
      assert.ok(Number.isInteger(retryAfterSec) && Number(retryAfterSec) > 0, "retryAfterSec");
      return true;
    });
  },
  "an unknown post is linkedin_not_found": async (linkedin, t) => {
    const { providerAccountRef } = (await connected(linkedin, world, t)).event;
    await assert.rejects(
      linkedin.listPostEngagers({ providerAccountRef, postUrl: UNKNOWN_POST, limit: 10 }),
      failsWith("linkedin_not_found"),
    );
  },
  "sendInvite leaves an invitation pending, in listPendingInvites and getRelation; withdrawInvite removes it":
    async (linkedin, t) => {
      if (!world.recipient) return t.skip("no member to invite in this world");
      const { providerAccountRef } = (await connected(linkedin, world, t)).event;
      const memberRef = await world.recipient(providerAccountRef);
      if (memberRef === undefined) return t.skip("no member to invite in this world");
      const member = { providerAccountRef, memberRef };
      const stranger = { connected: false, invitationPending: false };
      assert.deepEqual(await linkedin.getRelation(member), stranger);
      const start = Date.now();
      const sent = await linkedin.sendInvite({ ...member, idempotencyKey: "contract-invite" });
      assert.ok(answeredAt(sent.sentAt, start), "sentAt");
      assert.deepEqual(await linkedin.getRelation(member), {
        ...stranger,
        invitationPending: true,
      });
      const listed = (await pendingInvites(linkedin, providerAccountRef)).filter(
        ({ invitationRef }) => invitationRef === sent.invitationRef,
      );
      assert.deepEqual(
        listed.map((invite) => invite.memberRef),
        [memberRef],
      );
      const { withdrawnAt } = await linkedin.withdrawInvite({
        providerAccountRef,
        invitationRef: sent.invitationRef,
      });
      assert.ok(answeredAt(withdrawnAt, start), "withdrawnAt");
      assert.deepEqual(await linkedin.getRelation(member), stranger);
      const left = await pendingInvites(linkedin, providerAccountRef);
      assert.ok(!left.some(({ invitationRef }) => invitationRef === sent.invitationRef));
    },
  "sendMessage to a relation: listRecentMessages gives it as refs and a time, never its text":
    async (linkedin, t) => {
      if (!world.recipient) return t.skip("no relation to message in this world");
      const { providerAccountRef } = (await connected(linkedin, world, t)).event;
      const memberRef = await world.recipient(providerAccountRef, { relation: true });
      if (memberRef === undefined) return t.skip("no relation to message in this world");
      const member = { providerAccountRef, memberRef };
      assert.deepEqual(await linkedin.getRelation(member), {
        connected: true,
        invitationPending: false,
      });
      const start = Date.now();
      const since = new Date(start - SKEW_MS);
      const text = "A message from the LinkedIn port's contract suite";
      const sent = await linkedin.sendMessage({
        ...member,
        text,
        idempotencyKey: "contract-message",
      });
      assert.ok(answeredAt(sent.sentAt, start), "sentAt");
      // The member's chat looked up, then the chat given.
      for (const chat of [{}, { chatRef: sent.chatRef }]) {
        const { messages } = await linkedin.listRecentMessages({ ...member, ...chat, since });
        const found = messages.filter(({ messageRef }) => messageRef === sent.messageRef);
        assert.deepEqual(
          found.map(({ chatRef, fromAccount }) => ({ chatRef, fromAccount })),
          [{ chatRef: sent.chatRef, fromAccount: true }],
        );
        assert.ok(!JSON.stringify(messages).includes(text), "no message text");
      }
    },
  "a read and a send on a disconnected account are linkedin_account_disconnected": async (
    linkedin,
    t,
  ) => {
    if (!world.disconnected) return t.skip("no disconnected account in this world");
    const providerAccountRef = await world.disconnected();
    const member = { providerAccountRef, memberRef: "contract-member" };
    const idempotencyKey = "contract-disconnected";
    const since = { postedSince: new Date(0), limit: 10 };
    const calls = {
      listPostEngagers: () =>
        linkedin.listPostEngagers({ providerAccountRef, postUrl: UNKNOWN_POST, limit: 10 }),
      getRelation: () => linkedin.getRelation(member),
      listPendingInvites: () => linkedin.listPendingInvites({ providerAccountRef }),
      listRecentMessages: () => linkedin.listRecentMessages({ ...member, since: new Date() }),
      searchPosts: () =>
        linkedin.searchPosts({ providerAccountRef, phrase: "a contract phrase", ...since }),
      listAuthorPosts: () =>
        linkedin.listAuthorPosts({ providerAccountRef, authorUrl: UNKNOWN_AUTHORS[0], ...since }),
      listOwnPosts: () => linkedin.listOwnPosts({ providerAccountRef, ...since }),
      getCompany: () => linkedin.getCompany({ providerAccountRef, companyUrl: UNKNOWN_AUTHORS[1] }),
      getContactEmails: () => linkedin.getContactEmails(member),
      sendInvite: () => linkedin.sendInvite({ ...member, idempotencyKey }),
      sendMessage: () => linkedin.sendMessage({ ...member, text: "Hello", idempotencyKey }),
      withdrawInvite: () =>
        linkedin.withdrawInvite({ providerAccountRef, invitationRef: "contract-invitation" }),
    };
    for (const [method, call] of Object.entries(calls)) {
      await assert.rejects(call(), (error: unknown) => {
        const code = "linkedin_account_disconnected";
        assert.ok(isAppError(error) && error.code === code, `${method}: ${String(error)}`);
        const reason = error.details?.reason;
        const known: readonly unknown[] = LINKEDIN_DISCONNECT_REASONS;
        assert.ok(reason === undefined || known.includes(reason), `${method}: ${String(reason)}`);
        return true;
      });
    }
  },
});
