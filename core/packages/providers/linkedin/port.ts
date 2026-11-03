// The LinkedIn port (docs/architecture.md §9, briefs §11 RB-11.1.4, §9 RB-9.1.2 reduced): every
// LinkedIn call of the product goes through these eleven methods, in our words: a hosted
// authentication link for the user's own account, its status and its own member id, a post's
// engagers, a profile and the vendor's webhooks, verified, then read as typed events (README.md
// "Events"); then the sends, a connection request with an optional note and a message, a
// withdrawal, and the reads a send is checked with: the pending invitations, a chat's recent
// messages as refs and times, a relation. Each send carries its step's idempotency key
// (RB-1.2.4), which an adapter may ignore. No method likes, comments, reshares, endorses, sends
// InMail or reads contact info (RB-9.1.3; README.md "What the port will never have"). A profile and
// an engager hold business fields only: no contact info, photo, birthday, pronouns or
// special-category field, nothing a visibility setting hides (docs/rules/security.md §1); parsing
// drops every other key (README.md "Profiles and engagers"), and the boundary checks every output,
// in production too.
import { z } from "zod";
import { definePort } from "../_pattern/index.ts";
import {
  EVENT_ATTENDEES_MAX,
  EVENT_KEY_MAX_CHARS,
  EVENT_TEXT_MAX_CHARS,
  IDEMPOTENCY_KEY_MAX_CHARS,
  MESSAGE_MAX_CHARS,
  NOTE_MAX_CHARS,
} from "./constants.ts";

export { linkedinConfig } from "./config.ts";
export type { LinkedinFake } from "./fake/index.ts";

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
});

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
  },
  errors: {
    /** The vendor's rate limit: `details.retryAfterSec`, the seconds to wait. */
    linkedin_rate_limited: { status: 429 },
    /**
     * The account is not connected: `details.reason`, when the adapter knows it, one of
     * LINKEDIN_DISCONNECT_REASONS.
     */
    linkedin_account_disconnected: { status: 409 },
    /** No such account, post or profile, or none the account can see. */
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
