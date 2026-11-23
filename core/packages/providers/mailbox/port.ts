// The mailbox port (docs/architecture.md §9; F11 §4.1 and §6; briefs RB-12.1.1, RB-12.3.4, RB-13.1.1
// reduced, RB-12.2.2): a member's own Google or Microsoft mailbox, connected by OAuth with PKCE,
// kept fresh and revoked; one finished message sent under the platform's own Message-ID and found
// again by it; what is new in the platform's threads since a cursor, polled; one of those threads
// read by its ref. Eight methods and nothing more (README.md "What the port will never have"). Every
// input is an exact object, a raw message passes raw.ts's checks before any call, the match
// (match.ts) runs inside the adapter, and the boundary checks every output, in production too.
import { z } from "zod";
import { definePort } from "../_pattern/index.ts";
import {
  ADDRESS_MAX_CHARS,
  ANY_ADDRESS,
  ANY_MESSAGE_ID,
  BOUNCE_STATUS_FORM,
  CODE_CHALLENGE_FORM,
  CODE_MAX_CHARS,
  CODE_VERIFIER_FORM,
  CURSOR_MAX_CHARS,
  FEEDBACK_TYPE_FORM,
  IDEMPOTENCY_KEY_MAX_CHARS,
  MAILBOX_LIST_LIMIT_MAX,
  MAILBOX_MATCH_MAX,
  MAILBOX_SCOPES,
  MAILBOX_TEXT_MAX_CHARS,
  MESSAGE_ID_MAX_CHARS,
  PERMANENT_CLASS,
  PLAIN_ADDRESS,
  PLATFORM_MESSAGE_ID,
  REF_MAX_CHARS,
  STATE_FORM,
  SUBJECT_MAX_CHARS,
  TOKEN_MAX_CHARS,
  URL_MAX_CHARS,
} from "./constants.ts";
import { rawMessageProblems } from "./raw.ts";

export { mailboxAdapterFor, mailboxConfig } from "./config.ts";
export {
  MAILBOX_FIND_SETTLE_SECONDS,
  MAILBOX_LIST_LIMIT_MAX,
  MAILBOX_MATCH_MAX,
  MAILBOX_MESSAGE_ID_PREFIX,
  MAILBOX_PROVIDERS,
  MAILBOX_RAW_MAX_BYTES,
  MAILBOX_SCOPES,
  MAILBOX_TEXT_MAX_CHARS,
  type MailboxProvider,
  type MailboxScope,
} from "./constants.ts";
export type { FakeConsent, MailboxFake, PlayedMessage } from "./fake/index.ts";
export { isPlatformMessageId, messageIdFor } from "./message-id.ts";
export { codeChallengeFor, newCodeVerifier } from "./pkce.ts";
export { rawMessageProblems } from "./raw.ts";

/** A provider's message or thread ref: opaque, never parsed. */
const ref = z.string().min(1).max(REF_MAX_CHARS);
const token = z.string().min(1).max(TOKEN_MAX_CHARS);
/** The callback a consent returns to, or a consent page: http for a local host in development. */
const webUrl = z.url({ protocol: /^https?$/ }).max(URL_MAX_CHARS);
/** A character is a code point, as the LinkedIn port counts them: an emoji counts once. */
const chars = (max: number) =>
  z
    .string()
    .refine(
      (value) => value.isWellFormed() && Array.from(value).length <= max,
      `at most ${max} characters`,
    );
/** An address as a message gives it, in lower case. */
const address = z
  .string()
  .max(ADDRESS_MAX_CHARS)
  .regex(ANY_ADDRESS, "an address")
  .refine((value) => value === value.toLowerCase(), "in lower case");
const platformMessageId = z
  .string()
  .max(MESSAGE_ID_MAX_CHARS)
  .regex(PLATFORM_MESSAGE_ID, "a Message-ID of the platform's form");
/** A Message-ID as a provider keeps it, without its angle brackets. */
const messageId = z.string().max(MESSAGE_ID_MAX_CHARS).regex(ANY_MESSAGE_ID, "a Message-ID");
const subject = chars(SUBJECT_MAX_CHARS);
const text = chars(MAILBOX_TEXT_MAX_CHARS);
const limit = z.int().min(1).max(MAILBOX_LIST_LIMIT_MAX);
/** What the person granted, in the port's words: each once, in MAILBOX_SCOPES order. */
const scopes = z
  .array(z.enum(MAILBOX_SCOPES))
  .refine(
    (granted) =>
      granted.join() === MAILBOX_SCOPES.filter((scope) => granted.includes(scope)).join(),
    "each scope once, in MAILBOX_SCOPES order",
  );

/** Every event's refs and the provider's time of the message. */
const refs = { messageRef: ref, threadRef: ref, at: z.date() };
const reply = z.strictObject({
  kind: z.literal("reply"),
  ...refs,
  messageId: messageId.nullable(),
  inReplyTo: messageId.nullable(),
  fromAddress: address.nullable(),
  subject,
  text,
});
const sent = z.strictObject({
  kind: z.literal("sent"),
  ...refs,
  messageId: messageId.nullable(),
  subject,
  text,
});
/** A delivery report naming a matched Message-ID: no recipient address, no text. */
const bounce = z
  .strictObject({
    kind: z.literal("bounce"),
    ...refs,
    originalMessageId: platformMessageId,
    permanent: z.boolean(),
    status: z.string().regex(BOUNCE_STATUS_FORM, "a 4.x.x or 5.x.x status"),
  })
  .refine(
    (event) =>
      typeof event.status !== "string" ||
      event.permanent === event.status.startsWith(PERMANENT_CLASS),
    "permanent exactly for a 5.x.x status",
  );
const complaint = z.strictObject({
  kind: z.literal("complaint"),
  ...refs,
  originalMessageId: platformMessageId,
  feedbackType: z.string().regex(FEEDBACK_TYPE_FORM, "a feedback type"),
});
const unsubscribeRequest = z.strictObject({
  kind: z.literal("unsubscribe_request"),
  ...refs,
  subject,
});
/** What listNewMessages answers, keyed by `kind` (README.md "Events"). */
export const mailboxEvent = z.discriminatedUnion("kind", [
  reply,
  sent,
  bounce,
  complaint,
  unsubscribeRequest,
]);
/** What readThread answers: a thread's messages, never an unsubscribe mail. */
export const mailboxThreadEvent = z.discriminatedUnion("kind", [reply, sent, bounce, complaint]);
const match = z.strictObject({
  threadRefs: z.array(ref).max(MAILBOX_MATCH_MAX),
  messageIds: z.array(platformMessageId).max(MAILBOX_MATCH_MAX),
  unsubscribeSubjectPrefix: z.string().min(1).max(SUBJECT_MAX_CHARS).optional(),
});
const send = z
  .strictObject({
    accessToken: token,
    raw: z.string(),
    messageId: platformMessageId,
    threadRef: ref.optional(),
    idempotencyKey: z.string().min(1).max(IDEMPOTENCY_KEY_MAX_CHARS),
  })
  .superRefine(({ raw, messageId }, context) => {
    // Runs after the fields' own issues too: only strings are checked.
    if (typeof raw !== "string" || typeof messageId !== "string") return;
    for (const message of rawMessageProblems(raw, messageId))
      context.addIssue({ code: "custom", path: ["raw"], message });
  });

export type MailboxEvent = z.output<typeof mailboxEvent>;
export type MailboxThreadEvent = z.output<typeof mailboxThreadEvent>;
export type MailboxMatch = z.output<typeof match>;

export const mailboxPort = definePort({
  name: "mailbox",
  errorPrefix: "mailbox",
  alwaysCheckOutputs: true,
  methods: {
    createAuthUrl: {
      input: z.strictObject({
        redirectUri: webUrl,
        state: z.string().regex(STATE_FORM, "URL-safe characters"),
        codeChallenge: z.string().regex(CODE_CHALLENGE_FORM, "an S256 challenge"),
        loginHint: z.string().max(ADDRESS_MAX_CHARS).regex(PLAIN_ADDRESS, "an address").optional(),
      }),
      output: z.strictObject({ url: webUrl }),
    },
    exchangeCode: {
      input: z.strictObject({
        code: z.string().min(1).max(CODE_MAX_CHARS),
        redirectUri: webUrl,
        codeVerifier: z.string().regex(CODE_VERIFIER_FORM, "a PKCE verifier"),
      }),
      output: z.strictObject({
        address: address.nullable(),
        refreshToken: token,
        accessToken: token,
        accessExpiresAt: z.date(),
        scopes,
      }),
    },
    refreshAccess: {
      input: z.strictObject({ refreshToken: token }),
      output: z.strictObject({
        accessToken: token,
        accessExpiresAt: z.date(),
        refreshToken: token.optional(),
      }),
    },
    revokeAccess: {
      input: z.strictObject({ refreshToken: token }),
      output: z.strictObject({ revoked: z.boolean() }),
    },
    sendMessage: {
      input: send,
      output: z.strictObject({
        messageId,
        messageRef: ref.nullable(),
        threadRef: ref.nullable(),
        sentAt: z.date(),
      }),
    },
    findSent: {
      input: z.strictObject({ accessToken: token, messageId: platformMessageId }),
      output: z.discriminatedUnion("found", [
        z.strictObject({
          found: z.literal(true),
          messageRef: ref,
          threadRef: ref,
          sentAt: z.date(),
        }),
        z.strictObject({ found: z.literal(false) }),
      ]),
    },
    listNewMessages: {
      input: z.strictObject({
        accessToken: token,
        address,
        cursor: z.string().min(1).max(CURSOR_MAX_CHARS).nullable(),
        match,
        limit,
      }),
      output: z.strictObject({
        events: z.array(mailboxEvent).max(MAILBOX_LIST_LIMIT_MAX),
        cursor: z.string().min(1).max(CURSOR_MAX_CHARS),
        more: z.boolean(),
      }),
    },
    readThread: {
      input: z.strictObject({ accessToken: token, address, threadRef: ref, limit }),
      output: z.strictObject({
        events: z.array(mailboxThreadEvent).max(MAILBOX_LIST_LIMIT_MAX),
        more: z.boolean(),
      }),
    },
  },
  errors: {
    /** The grant is gone: revoked by the person or an admin, expired, the password changed. */
    mailbox_token_revoked: { status: 401 },
    /** The access token is no longer valid: refresh, then call again. */
    mailbox_access_expired: { status: 401 },
    /** A call the grant does not cover, such as a send after the person withdrew sending. */
    mailbox_scope_missing: { status: 403 },
    /** The provider's rate limit; `details.retryAfterSec`. */
    mailbox_rate_limited: { status: 429 },
    /** The provider's daily sending limit for the mailbox; `details.retryAfterSec` when known. */
    mailbox_quota_reached: { status: 429 },
    /** The provider refused this message for good. */
    mailbox_send_refused: { status: 422 },
    /** A thread or message the provider does not know, or a thread the platform did not start. */
    mailbox_not_found: { status: 404 },
    /** The provider no longer knows the cursor: start again with none. */
    mailbox_cursor_invalid: { status: 410 },
    /** Anything else, `details.status` only; after a send, the outcome is unknown. */
    mailbox_provider_error: { status: 502 },
  },
});
