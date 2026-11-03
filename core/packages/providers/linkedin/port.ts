// The LinkedIn port (docs/architecture.md §9, briefs §11 RB-11.1.4 reduced to reads): every LinkedIn
// call of the product goes through these five methods, in our words: a hosted authentication link
// for the user's own account, its status, a post's engagers, a profile and the vendor's account
// webhooks. No method sends anything. A profile and an engager hold business fields only: no contact
// info, photo, birthday, pronouns or special-category field, nothing a visibility setting hides
// (docs/rules/security.md §1); parsing drops every other key (README.md "Profiles and engagers").
import { z } from "zod";
import { definePort } from "../_pattern/index.ts";

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

export const LINKEDIN_ACCOUNT_STATUSES = [
  "connected",
  "disconnected",
  "credentials_required",
  "error",
] as const;
export const LINKEDIN_WEBHOOK_KINDS = [
  "account.connected",
  "account.disconnected",
  "account.credentials_required",
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

/** The webhook request as the host received it: its headers and the raw bytes of its body. */
const webhookRequest = z.strictObject({
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())]).optional()),
  rawBody: z.union([z.string(), z.instanceof(Uint8Array)]),
});

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
      output: z.strictObject({ status: z.enum(LINKEDIN_ACCOUNT_STATUSES), checkedAt: z.date() }),
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
    parseWebhook: {
      input: webhookRequest,
      output: z.strictObject({
        kind: z.enum(LINKEDIN_WEBHOOK_KINDS),
        providerAccountRef: ref,
        /** On account.connected: the `providerRef` of the link the account came through. */
        providerRef: ref.optional(),
      }),
    },
  },
  errors: {
    /** The vendor's rate limit: `details.retryAfterSec`, the seconds to wait. */
    linkedin_rate_limited: { status: 429 },
    /** The account is not connected (disconnected, or its credentials are needed). */
    linkedin_account_disconnected: { status: 409 },
    /** No such account, post or profile, or none the account can see. */
    linkedin_not_found: { status: 404 },
    /** A webhook whose signature does not match, or whose body is not the vendor's. */
    linkedin_webhook_invalid: { status: 401 },
    /** Anything else the vendor answered: `details.status`, never its body. */
    linkedin_provider_error: { status: 502 },
  },
});

type Methods = typeof linkedinPort.methods;
export type HostedAuthLink = z.output<Methods["createHostedAuthLink"]["output"]>;
export type AccountStatus = z.output<Methods["getAccountStatus"]["output"]>;
export type Engager = z.output<typeof linkedinEngager>;
export type Profile = z.output<typeof linkedinProfile>;
export type LinkedinWebhook = z.input<Methods["parseWebhook"]["input"]>;
export type LinkedinWebhookEvent = z.output<Methods["parseWebhook"]["output"]>;
