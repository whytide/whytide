// The LinkedIn port (docs/architecture.md §9, briefs §11 RB-11.1.4, §9 RB-9.1.2 reduced, §4
// RB-4.1.1): every LinkedIn call of the product goes through these sixteen methods, in our words: a
// hosted authentication link for the user's own account, its status and its own member id, a post's
// engagers, a profile and the vendor's webhooks, verified, then read as typed events (README.md
// "Events"); then the sends, a connection request with an optional note and a message, a
// withdrawal, and the reads a send is checked with: the pending invitations, a chat's recent
// messages as refs and times, a relation; then the post reads, the posts that hold a phrase, a
// member's or a company page's, and the account's own (README.md "Posts"); and a company page's
// business facts (README.md "Company pages", gamma-en-060); and, the one exception the owner allowed
// on 2026-11-13, behind LINKEDIN_CONTACT_INFO_ENABLED, the email addresses of a 1st-degree
// connection's "Contact info", nothing else of it (getContactEmails, gamma-en-087). Each send carries its
// step's idempotency key (RB-1.2.4), which an adapter may ignore. No method likes, comments,
// reshares, endorses, sends InMail or reads any other contact info (RB-9.1.3; README.md "What the
// port will never have"). A profile, an engager and a post's author hold business fields only: no contact
// info, photo, birthday, pronouns or special-category field, nothing a visibility setting hides
// (docs/rules/security.md §1); parsing drops every other key (README.md "Profiles and engagers"),
// and the boundary checks every output, in production too.
import { z } from "zod";
import { definePort } from "../_pattern/index.ts";
import {
  AUTHOR_PATHS,
  COMPANY_DESCRIPTION_MAX_CHARS,
  COMPANY_FOUNDED_YEAR,
  COMPANY_INDUSTRY_MAX_CHARS,
  COMPANY_NAME_MAX_CHARS,
  CONTACT_EMAILS_MAX,
  COUNTRY_CODE,
  EMAIL_MAX_CHARS,
  EVENT_ATTENDEES_MAX,
  EVENT_KEY_MAX_CHARS,
  EVENT_TEXT_MAX_CHARS,
  IDEMPOTENCY_KEY_MAX_CHARS,
  MESSAGE_MAX_CHARS,
  NOTE_MAX_CHARS,
  POST_EXCERPT_MAX_CHARS,
  POST_PATHS,
  POST_PHRASE_MAX_CHARS,
  POST_PHRASE_MAX_WORDS,
  POSTS_PAGE_MAX,
} from "./constants.ts";

export { linkedinConfig } from "./config.ts";
// The post reads' bounds and the author links they take, for a caller's own checks (gamma-p5-020).
export {
  AUTHOR_PATHS,
  POST_EXCERPT_MAX_CHARS,
  POST_PHRASE_MAX_CHARS,
  POST_PHRASE_MAX_WORDS,
  POSTS_PAGE_MAX,
} from "./constants.ts";
export type { FakeEngager, LinkedinFake } from "./fake/index.ts";

/** A vendor's id for an account, a member or a link: opaque, never parsed. */
const ref = z.string().min(1).max(256);
const cursor = z.string().min(1).max(2048);
/** A page of the app or the vendor's hosted page. */
const webUrl = z.url({ protocol: /^https?$/ }).max(2048);
/** A LinkedIn page: https on linkedin.com or a subdomain of it. */
const linkedinUrl = z
  .url({ protocol: /^https$/, hostname: /^(?:[a-z0-9-]+\.)*linkedin\.com$/ })
  .max(2048);
const text = (max: number) => z.string().max(max);
/** A text's characters as the port counts them: code points, so an emoji counts once. */
const charsOf = (value: string) => Array.from(value).length;
/** A well-formed text of at most `max` characters, so that no character is half of one. */
const chars = (max: number) =>
  z
    .string()
    .refine((value) => value.isWellFormed() && charsOf(value) <= max, `at most ${max} characters`);
/** A LinkedIn link whose path is of one of the forms given. */
const linkOf = (paths: readonly RegExp[], form: string) =>
  linkedinUrl.refine(
    (value) => paths.some((path) => path.test(URL.parse(value)?.pathname ?? "")),
    form,
  );
/** The step's key a send carries (RB-1.2.4): an adapter may honor it; Unipile does not. */
const idempotencyKey = z.string().min(1).max(IDEMPOTENCY_KEY_MAX_CHARS);

export const LINKEDIN_ACCOUNT_STATUSES = [
  "connected",
  "disconnected",
  "credentials_required",
  "error",
] as const;
/** The kinds parseWebhook gives (README.md "Events"). */
export const LINKEDIN_WEBHOOK_KINDS = [
  "account.connected",
  "account.disconnected",
  "account.credentials_required",
  "account.status",
  "invite.accepted",
  "message.received",
  "ignored",
] as const;
/** The status an account.status event carries: every one but `connected` is a disconnect reason. */
export const LINKEDIN_EVENT_STATUSES = [
  "connected",
  "credentials_required",
  "checkpoint",
  "restricted",
  "disconnected",
] as const;
/** Why an account is not connected: linkedin_account_disconnected's `details.reason`, if known. */
export const LINKEDIN_DISCONNECT_REASONS = [
  "credentials_required",
  "checkpoint",
  "restricted",
  "disconnected",
] as const;

/** A profile's business fields; parsing drops every other key. An adapter returns `linkedinProfile.parse(mapped)`. */
export const linkedinProfile = z.object({
  providerMemberRef: ref,
  profileUrl: linkedinUrl,
  firstName: text(100),
  lastName: text(100),
  headline: text(300),
  title: text(300),
  companyName: text(300),
  companyUrl: webUrl.optional(),
  locationText: text(300),
  industry: text(200).optional(),
  /**
   * Whether the person is a 1st-degree connection of the account, from the same answer; absent when
   * the vendor's answer does not say (connect-already-connected). Not a business field: no caller
   * stores it on a person.
   */
  connected: z.boolean().optional(),
  fetchedAt: z.date(),
});
/** Someone who reacted to, commented on or reposted a post; parsing drops every other key. */
export const linkedinEngager = z.object({
  providerMemberRef: ref,
  profileUrl: linkedinUrl,
  /** Shown as the comment's author in a signal's evidence. */
  name: text(200),
  headline: text(300),
  reaction: z.enum(["like", "comment", "repost"]),
  commentText: text(3000).optional(),
  engagedAt: z.date(),
  /** True when `engagedAt` is the vendor's date of the engagement, false when the listing's time. */
  dateKnown: z.boolean(),
});

/** Graphemes do not depend on the locale. */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/**
 * A post's excerpt (RB-4.4.3): its first POST_EXCERPT_MAX_CHARS characters, cut between two
 * graphemes, so that an emoji at the edge, of one code point or of several, is whole or left out.
 */
export function postExcerpt(text: string): string {
  let excerpt = "";
  let count = 0;
  for (const { segment } of graphemes.segment(text.toWellFormed())) {
    count += charsOf(segment);
    if (count > POST_EXCERPT_MAX_CHARS) break;
    excerpt += segment;
  }
  return excerpt;
}

/** A post's author who is a member; parsing drops every other key. */
const memberAuthor = z.object({
  kind: z.literal("member"),
  providerMemberRef: ref,
  /** The member's page, which listAuthorPosts takes. */
  profileUrl: linkOf([AUTHOR_PATHS.member], "a member's page, /in/<id>"),
  name: text(200),
  headline: text(300),
});
/** A post's author that is a company page; parsing drops every other key. */
const companyAuthor = z.object({
  kind: z.literal("company"),
  /** The company's page, which listAuthorPosts takes. */
  companyUrl: linkOf([AUTHOR_PATHS.company], "a company's page, /company/<id>"),
  name: text(200),
});
/**
 * A post a read gives: its link, its date, its first characters and its author; parsing drops every
 * other key. An adapter returns `linkedinPost.parse(mapped)`.
 */
export const linkedinPost = z.object({
  /** In a form listPostEngagers reads, so that a caller passes it on unchanged. */
  postUrl: linkOf(POST_PATHS, "a post's link in a form listPostEngagers reads"),
  postedAt: z.date(),
  /** Someone's words: never in a log line, an error's details or a metric label. */
  excerpt: chars(POST_EXCERPT_MAX_CHARS),
  author: z.discriminatedUnion("kind", [memberAuthor, companyAuthor]),
});
/** A page of posts, strict: a vendor's key fails the boundary's check in every environment. */
const postsPage = z.strictObject({
  posts: z.array(
    z.strictObject({
      ...linkedinPost.shape,
      author: z.discriminatedUnion("kind", [
        z.strictObject(memberAuthor.shape),
        z.strictObject(companyAuthor.shape),
      ]),
    }),
  ),
  nextCursor: cursor.nullable(),
});
/** A phrase's words: its runs of characters between spaces. */
const wordsOf = (value: string) => value.split(/\s+/u).filter((word) => word !== "").length;
/** The exact phrase searchPosts looks for (RB-4.1.1). */
const phrase = chars(POST_PHRASE_MAX_CHARS).refine(
  (value) => wordsOf(value) >= 1 && wordsOf(value) <= POST_PHRASE_MAX_WORDS,
  `1 to ${POST_PHRASE_MAX_WORDS} words`,
);
/** The keys every post read ends with: the date it reads back to, the page and its size. */
const postsQuery = {
  postedSince: z.date(),
  cursor: cursor.optional(),
  limit: z.int().min(1).max(POSTS_PAGE_MAX),
};

/** A size band, `to` at least `from`, made strict or not as the object around it. */
const sizeBand = (object: typeof z.object | typeof z.strictObject) =>
  object({ from: z.int().min(0), to: z.int().min(1).optional() }).refine(
    ({ from, to }) => to === undefined || to >= from,
    "`to` at least `from`",
  );
/**
 * A company page's business facts (README.md "Company pages"); parsing drops every other key, as for
 * a profile. An adapter returns `linkedinCompany.parse(mapped)`. No person, follower or post.
 */
export const linkedinCompany = z.object({
  /** The page, in the form getCompany takes. */
  companyUrl: linkOf([AUTHOR_PATHS.company], "a company's page, /company/<id>"),
  name: text(COMPANY_NAME_MAX_CHARS),
  website: webUrl.optional(),
  industry: text(COMPANY_INDUSTRY_MAX_CHARS).optional(),
  employeeCount: z.int().min(1).optional(),
  /** LinkedIn's size band, `to` left out for an open one (10,001+). */
  employeeRange: sizeBand(z.object).optional(),
  /** The headquarters' country, ISO 3166-1 alpha-2. */
  headquartersCountry: z.string().regex(COUNTRY_CODE).optional(),
  description: text(COMPANY_DESCRIPTION_MAX_CHARS).optional(),
  foundedYear: z.int().min(COMPANY_FOUNDED_YEAR.min).max(COMPANY_FOUNDED_YEAR.max).optional(),
  fetchedAt: z.date(),
});

/**
 * An email address of a member's "Contact info" (getContactEmails, gamma-en-087): lower case, at most
 * EMAIL_MAX_CHARS. The one contact field a type of this port carries, by the owner's exception.
 */
const contactEmail = z
  .email()
  .max(EMAIL_MAX_CHARS)
  .refine((address) => address === address.toLowerCase(), "lower case");

/** A pending invitation of the account's: to whom, since when. */
const pendingInvite = z.strictObject({ invitationRef: ref, memberRef: ref, sentAt: z.date() });
/** A message of a chat as refs and its time, never its text: from the account itself or not. */
const recentMessage = z.strictObject({
  messageRef: ref,
  chatRef: ref,
  fromAccount: z.boolean(),
  sentAt: z.date(),
});

/** The webhook request as the host received it: its headers and the raw bytes of its body. */
const webhookRequest = z.strictObject({
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())]).optional()),
  rawBody: z.union([z.string(), z.instanceof(Uint8Array)]),
});

/** The provider's event or message id, the same on every redelivery: the receiver's key. */
const eventKey = z.string().min(1).max(EVENT_KEY_MAX_CHARS);
/** What an account event says applies by state: no eventKey. */
const accountStatusEvent = z.strictObject({
  kind: z.literal("account.status"),
  providerAccountRef: ref,
  status: z.enum(LINKEDIN_EVENT_STATUSES),
});
/** A member accepted an invitation: a new relation of the account's. */
const inviteAccepted = z.strictObject({
  kind: z.literal("invite.accepted"),
  providerAccountRef: ref,
  eventKey,
  memberRef: ref,
  /** Only what the provider says; an acceptance counts from its detection (RB-9.2.2, RB-11.2.4). */
  occurredAt: z.date().optional(),
});
/** A message in one of the account's chats, from the account itself or not. */
const messageReceived = z.strictObject({
  kind: z.literal("message.received"),
  providerAccountRef: ref,
  eventKey,
  chatRef: ref,
  messageRef: ref,
  senderMemberRef: ref,
  /** Sent by the account, from Whytide or by hand; false where the adapter cannot tell. */
  fromAccount: z.boolean(),
  attendeeMemberRefs: z.array(ref).max(EVENT_ATTENDEES_MAX),
  /** Personal data: here only, never in an error's details, a log line or a metric label. */
  text: z.string().max(EVENT_TEXT_MAX_CHARS),
  sentAt: z.date(),
});
/** A verified webhook in Whytide's words, keyed by kind (README.md "Events"). */
const webhookEvent = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("account.connected"),
    providerAccountRef: ref,
    /** The `providerRef` of the link the account came through, on a pairing notify. */
    providerRef: ref.optional(),
  }),
  z.strictObject({ kind: z.literal("account.disconnected"), providerAccountRef: ref }),
  z.strictObject({ kind: z.literal("account.credentials_required"), providerAccountRef: ref }),
  accountStatusEvent,
  inviteAccepted,
  messageReceived,
  /** A verified event of a kind the port does not know: a result, so the provider stops retrying. */
  z.strictObject({ kind: z.literal("ignored") }),
]);

export const linkedinPort = definePort({
  name: "linkedin",
  methods: {
    createHostedAuthLink: {
      input: z.strictObject({
        successUrl: webUrl,
        failureUrl: webUrl,
        expiresInMin: z.int().min(1).max(1440),
      }),
      output: z.strictObject({ url: webUrl, expiresAt: z.date(), providerRef: ref }),
    },
    getAccountStatus: {
      input: ref,
      output: z.strictObject({
        status: z.enum(LINKEDIN_ACCOUNT_STATUSES),
        checkedAt: z.date(),
        /** The account's own member id, the form of memberRef; null where the vendor gives none. */
        memberRef: ref.nullable(),
      }),
    },
    /**
     * A post's engagers, newest first by `engagedAt` on every page and across pages, ties in the
     * vendor's order: a caller stops paging at its watermark (alpha-p8-020).
     */
    listPostEngagers: {
      input: z.strictObject({
        providerAccountRef: ref,
        postUrl: linkedinUrl,
        cursor: cursor.optional(),
        limit: z.int().min(1).max(100),
      }),
      output: z.strictObject({
        engagers: z.array(z.strictObject(linkedinEngager.shape)),
        nextCursor: cursor.nullable(),
      }),
    },
    getProfile: {
      input: z.strictObject({ providerAccountRef: ref, profileUrl: linkedinUrl }),
      output: z.strictObject(linkedinProfile.shape),
    },
    /** The signature checked in constant time before the body is read; then the event. */
    parseWebhook: { input: webhookRequest, output: webhookEvent },
    /** A connection request to a member, with a note or none (RB-11.2.5: none by default). */
    sendInvite: {
      input: z.strictObject({
        providerAccountRef: ref,
        memberRef: ref,
        note: z.string().max(NOTE_MAX_CHARS).optional(),
        idempotencyKey,
      }),
      output: z.strictObject({ invitationRef: ref, sentAt: z.date() }),
    },
    /** A message to a relation, in the chat given, else the member's own, found or opened. */
    sendMessage: {
      input: z.strictObject({
        providerAccountRef: ref,
        memberRef: ref,
        chatRef: ref.optional(),
        text: z.string().min(1).max(MESSAGE_MAX_CHARS),
        idempotencyKey,
      }),
      output: z.strictObject({ messageRef: ref, chatRef: ref, sentAt: z.date() }),
    },
    withdrawInvite: {
      input: z.strictObject({ providerAccountRef: ref, invitationRef: ref }),
      output: z.strictObject({ withdrawnAt: z.date() }),
    },
    /** The account's pending invitations, a page at a time; `nextCursor` null on the last page. */
    listPendingInvites: {
      input: z.strictObject({ providerAccountRef: ref, cursor: cursor.optional() }),
      output: z.strictObject({ invites: z.array(pendingInvite), nextCursor: cursor.nullable() }),
    },
    /**
     * The messages since `since` of the chat given, else of the member's chat: refs and times only,
     * never text, so that the check before a send moves no message.
     */
    listRecentMessages: {
      input: z.strictObject({
        providerAccountRef: ref,
        memberRef: ref,
        chatRef: ref.optional(),
        since: z.date(),
      }),
      output: z.strictObject({ messages: z.array(recentMessage) }),
    },
    getRelation: {
      input: z.strictObject({ providerAccountRef: ref, memberRef: ref }),
      output: z.strictObject({ connected: z.boolean(), invitationPending: z.boolean() }),
    },
    /**
     * The posts that hold the exact phrase, newest first by `postedAt`, at or after `postedSince`
     * only: a page at a time, `nextCursor` null on the last page and on the page that reaches
     * `postedSince`; a cursor reads the same page again (README.md "Posts").
     */
    searchPosts: {
      input: z.strictObject({ providerAccountRef: ref, phrase, ...postsQuery }),
      output: postsPage,
    },
    /** A member's or a company page's recent posts, paged as searchPosts. */
    listAuthorPosts: {
      input: z.strictObject({
        providerAccountRef: ref,
        authorUrl: linkOf(
          [AUTHOR_PATHS.member, AUTHOR_PATHS.company],
          "a member's page, /in/<id>, or a company's, /company/<id>",
        ),
        ...postsQuery,
      }),
      output: postsPage,
    },
    /** The account's own recent posts, paged as searchPosts. */
    listOwnPosts: {
      input: z.strictObject({ providerAccountRef: ref, ...postsQuery }),
      output: postsPage,
    },
    /** A company page's business facts, read through the account (README.md "Company pages"). */
    getCompany: {
      input: z.strictObject({
        providerAccountRef: ref,
        companyUrl: linkOf([AUTHOR_PATHS.company], "a company's page, /company/<id>"),
      }),
      output: z.strictObject({
        ...linkedinCompany.shape,
        employeeRange: sizeBand(z.strictObject).optional(),
      }),
    },
    /**
     * The email addresses a 1st-degree connection shows in "Contact info", lower case, each once,
     * CONTACT_EMAILS_MAX at most; none for a member who is not one or shows none. Never the section's
     * phones, addresses, birthday, messengers or websites. The owner's exception of 2026-11-13,
     * behind LINKEDIN_CONTACT_INFO_ENABLED; the linkedin module's readContactEmails is its only
     * caller (README.md "What the port will never have"; gamma-en-087).
     */
    getContactEmails: {
      input: z.strictObject({ providerAccountRef: ref, memberRef: ref }),
      output: z.strictObject({
        emails: z
          .array(contactEmail)
          .max(CONTACT_EMAILS_MAX)
          .refine((emails) => new Set(emails).size === emails.length, "each once"),
      }),
    },
  },
  errors: {
    /** The vendor's rate limit: `details.retryAfterSec`, the seconds to wait. */
    linkedin_rate_limited: { status: 429 },
    /**
     * The account is not connected: `details.reason`, when the adapter knows it, one of
     * LINKEDIN_DISCONNECT_REASONS.
     */
    linkedin_account_disconnected: { status: 409 },
    /** No such account, post, profile, author or company page, or none the account can see. */
    linkedin_not_found: { status: 404 },
    /** A webhook whose signature does not match, or whose body is not the vendor's. */
    linkedin_webhook_invalid: { status: 401 },
    /**
     * Anything else the vendor answered: `details.status`, never its body. After a send it is the
     * temporary error that leaves the outcome unknown: the caller checks before any retry.
     */
    linkedin_provider_error: { status: 502 },
    /** LinkedIn's own limit, such as the weekly invitation limit; not the vendor's rate limit. */
    linkedin_limit_reached: { status: 429 },
    /**
     * A permanent refusal of a send: already invited, already connected, not connected for a
     * message, the recipient unavailable.
     */
    linkedin_send_refused: { status: 422 },
  },
  // A vendor's field stops here in every environment, even where an adapter forgets to parse
  // (README.md "Profiles and engagers").
  alwaysCheckOutputs: true,
});

type Methods = typeof linkedinPort.methods;
export type HostedAuthLink = z.output<Methods["createHostedAuthLink"]["output"]>;
export type AccountStatus = z.output<Methods["getAccountStatus"]["output"]>;
export type Engager = z.output<typeof linkedinEngager>;
export type Profile = z.output<typeof linkedinProfile>;
export type LinkedinWebhook = z.input<Methods["parseWebhook"]["input"]>;
export type LinkedinWebhookEvent = z.output<Methods["parseWebhook"]["output"]>;
export type AccountStatusEvent = z.output<typeof accountStatusEvent>;
export type InviteAccepted = z.output<typeof inviteAccepted>;
export type MessageReceived = z.output<typeof messageReceived>;
export type LinkedinDisconnectReason = (typeof LINKEDIN_DISCONNECT_REASONS)[number];
export type SentInvite = z.output<Methods["sendInvite"]["output"]>;
export type SentMessage = z.output<Methods["sendMessage"]["output"]>;
export type PendingInvite = z.output<typeof pendingInvite>;
export type RecentMessage = z.output<typeof recentMessage>;
export type LinkedinRelation = z.output<Methods["getRelation"]["output"]>;
export type LinkedinPost = z.output<typeof linkedinPost>;
export type PostAuthor = LinkedinPost["author"];
export type PostsPage = z.output<typeof postsPage>;
export type LinkedinCompany = z.output<typeof linkedinCompany>;
export type LinkedinContactEmails = z.output<Methods["getContactEmails"]["output"]>;
