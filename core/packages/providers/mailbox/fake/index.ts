// The mailbox fake (README.md "The fake"): grants, tokens and mailboxes in memory, enough for every
// email task to run and test without a vendor. A consent is consentNext's, else a fake address with
// both scopes; createAuthUrl answers the redirectUri itself, with a code and the state, so that a
// test's browser lands on the callback at once; exchangeCode checks the code, the redirectUri and
// the PKCE verifier, and refreshAccess rotates the refresh token. Every message, sent or played, is
// kept as raw text in its mailbox and read as an adapter reads one: its head from its HEAD_FIELDS
// through match.ts, then the whole message where the match may take it, so that the fake answers
// only what the match accepts. It ignores the idempotency key, as Gmail and Graph do: a repeated
// send is a second message. It never logs. create() refuses APP_ENV=production: the fake never
// stands in for a mailbox on a server.
import { randomUUID } from "node:crypto";
import { AppError, platformConfig } from "@whytide/platform";
import {
  createFake,
  defineAdapter,
  type FakeContext,
  type PortErrorCode,
  patternErrors,
} from "../../_pattern/index.ts";
import {
  FAILED_ACTION,
  FIELD_NAMES,
  HEAD_FIELDS,
  MAILBOX_SCOPES,
  type MailboxScope,
} from "../constants.ts";
import {
  headOf,
  type MailboxMatcher,
  type MessageHead,
  mailboxMatcher,
  platformThread,
} from "../match.ts";
import { addressIn, readText, valuesOf } from "../mime.ts";
import { codeChallengeFor } from "../pkce.ts";
import { type MailboxEvent, type MailboxThreadEvent, mailboxPort } from "../port.ts";
import {
  ACCESS_TTL_SECONDS,
  BOUNCE_STATUS,
  FAKE_ADDRESS,
  FAKE_FRIEND,
  FAKE_LEAD,
  FAKE_MAILER,
  FAKE_MESSAGE_DOMAIN,
  FEEDBACK_TYPE,
  PLAYED,
  PREFIX,
  REPORT_BOUNDARY,
  RETRY_AFTER_SEC,
} from "./constants.ts";

const { errors } = mailboxPort;
type Code = PortErrorCode<typeof mailboxPort>;
type Details = Record<string, unknown> | undefined;
type Grant = {
  readonly mailbox: string;
  readonly scopes: readonly MailboxScope[];
  revoked: boolean;
};
type Token = { readonly grant: Grant; readonly kind: "refresh" | "access"; readonly until: number };
/** A message in a mailbox: the raw text, its head as an adapter reads it, its place in time. */
type Stored = {
  readonly seq: number;
  readonly mailbox: string;
  readonly head: MessageHead;
  readonly raw: string;
};
/** What the next exchangeCode grants: a null address is a grant that does not show it. */
export type FakeConsent = {
  readonly address?: string | null;
  readonly scopes?: readonly MailboxScope[];
};
/** A played message's refs and Message-ID, for a test to match on. */
export type PlayedMessage = {
  readonly messageRef: string;
  readonly threadRef: string;
  readonly messageId: string;
};
/** What a play helper may be given; each has its default (constants.ts PLAYED). */
export type Play = {
  readonly from?: string;
  readonly to?: string;
  readonly subject?: string;
  readonly text?: string;
  readonly threadRef?: string;
  readonly messageId?: string;
};
type Report = { readonly originalMessageId: string };
/** Where a played message goes: the thread of the message it answers, the thread given, a new one. */
type Placed = { readonly into?: Stored; readonly threadRef?: string; readonly messageId?: string };
type State = {
  readonly consents: FakeConsent[];
  readonly codes: Map<string, { readonly redirectUri: string; readonly codeChallenge: string }>;
  readonly tokens: Map<string, Token>;
  /** Every mailbox's messages, in arrival order: `seq` is the place, 1 for the first. */
  readonly messages: Stored[];
  /** The latest connection's mailbox, where a played message lands unless it answers one. */
  mailbox: string;
  readonly afterSend: { readonly code: Code; readonly details: Details }[];
  findMisses: number;
};
type Context = FakeContext<typeof mailboxPort, State>;

export const mailboxFake = createFake(mailboxPort, {
  state: (): State => ({
    consents: [],
    codes: new Map(),
    tokens: new Map(),
    messages: [],
    mailbox: FAKE_ADDRESS,
    afterSend: [],
    findMisses: 0,
  }),
  methods: (fake) => ({
    createAuthUrl: async ({ redirectUri, state, codeChallenge }) => {
      const code = `${PREFIX.code}${randomUUID()}`;
      fake.state.codes.set(code, { redirectUri, codeChallenge });
      const url = new URL(redirectUri);
      url.searchParams.set("code", code);
      url.searchParams.set("state", state);
      return { url: url.href };
    },
    exchangeCode: async ({ code, redirectUri, codeVerifier }) => {
      const pending = fake.state.codes.get(code);
      fake.state.codes.delete(code); // a code works once
      if (
        pending?.redirectUri !== redirectUri ||
        pending.codeChallenge !== codeChallengeFor(codeVerifier)
      ) {
        const reason = "a code the fake did not give or gave for another redirectUri or verifier";
        throw new AppError(mailboxPort.codes.input, {
          details: { method: "exchangeCode", reason },
        });
      }
      const { address = FAKE_ADDRESS, scopes = MAILBOX_SCOPES } = fake.state.consents.shift() ?? {};
      const shown = address === null ? null : address.toLowerCase();
      const granted = MAILBOX_SCOPES.filter((scope) => scopes.includes(scope));
      const grant: Grant = { mailbox: shown ?? FAKE_ADDRESS, scopes: granted, revoked: false };
      fake.state.mailbox = grant.mailbox;
      return { address: shown, ...issue(fake, grant), scopes: granted };
    },
    refreshAccess: async ({ refreshToken }) => {
      const grant = grantOf(fake, refreshToken, "refresh");
      fake.state.tokens.delete(refreshToken); // rotated: only the new one refreshes from now on
      return issue(fake, grant);
    },
    revokeAccess: async ({ refreshToken }) => {
      grantOf(fake, refreshToken, "refresh").revoked = true;
      return { revoked: true };
    },
    sendMessage: async ({ accessToken, raw, messageId, threadRef }) => {
      const { mailbox } = grantOf(fake, accessToken, "access", "send");
      if (
        threadRef !== undefined &&
        !inMailbox(fake, mailbox).some((m) => m.head.threadRef === threadRef)
      )
        throw new AppError(errors.mailbox_not_found);
      const head = store(fake, mailbox, raw, threadRef);
      const failure = fake.state.afterSend.shift();
      if (failure) throw new AppError(failure.code, { details: failure.details });
      return { messageId, messageRef: head.messageRef, threadRef: head.threadRef, sentAt: head.at };
    },
    findSent: async ({ accessToken, messageId }) => {
      const { mailbox } = grantOf(fake, accessToken, "access", "read");
      const head = inMailbox(fake, mailbox).find((m) => m.head.messageId === messageId)?.head;
      if (fake.state.findMisses > 0) {
        fake.state.findMisses -= 1;
        return { found: false as const };
      }
      if (head === undefined) return { found: false as const };
      return {
        found: true as const,
        messageRef: head.messageRef,
        threadRef: head.threadRef,
        sentAt: head.at,
      };
    },
    listNewMessages: async ({ accessToken, address, cursor, match, limit }) => {
      const { mailbox } = grantOf(fake, accessToken, "access", "read");
      const latest = fake.state.messages.length;
      if (cursor === null) return { events: [], cursor: cursorOf(latest), more: false };
      const since = seqOf(cursor, latest);
      const after = inMailbox(fake, mailbox).filter((m) => m.seq > since);
      const read = after.slice(0, limit);
      const more = after.length > limit;
      const events = eventsOf(mailboxMatcher({ address, match }), read);
      return { events, cursor: cursorOf(more ? (read.at(-1)?.seq ?? since) : latest), more };
    },
    readThread: async ({ accessToken, address, threadRef, limit }) => {
      const { mailbox } = grantOf(fake, accessToken, "access", "read");
      const thread = inMailbox(fake, mailbox).filter((m) => m.head.threadRef === threadRef);
      const read = platformThread(
        thread.map((m) => m.head),
        { address, threadRef, limit },
      );
      if (read === undefined) throw new AppError(errors.mailbox_not_found);
      const newest = read.newest.flatMap((head) => thread.filter((m) => m.head === head));
      const events = eventsOf(read.matcher, newest).filter(
        (event): event is MailboxThreadEvent => event.kind !== "unsubscribe_request",
      );
      return { events, more: read.more };
    },
  }),
  helpers: (fake) => ({
    /** What the next exchangeCode grants; consents queue up. */
    consentNext: (consent: FakeConsent): void => void fake.state.consents.push(consent),
    /** A reply from someone else to the message under `inReplyTo`: in its thread, else a new one. */
    playReply: (played: Play & { readonly inReplyTo: string }): PlayedMessage => {
      const original = byMessageId(fake, played.inReplyTo);
      const fields = {
        From: played.from ?? toOf(original) ?? FAKE_LEAD,
        Subject: played.subject ?? `Re: ${original?.head.subject ?? ""}`,
        "In-Reply-To": `<${played.inReplyTo}>`,
        References: `<${played.inReplyTo}>`,
      };
      return play(fake, fields, played.text ?? PLAYED.replyText, { into: original });
    },
    /** The mailbox's own message, typed in the mail program: in the thread given, else a new one; under the Message-ID given, else one of the program's form. */
    playSent: (played: Play = {}): PlayedMessage => {
      const { to = FAKE_LEAD, subject = PLAYED.sentSubject, text = PLAYED.sentText } = played;
      return play(fake, { From: fake.state.mailbox, To: to, Subject: subject }, text, played);
    },
    /** A delivery report (RFC 3464) for the message under `originalMessageId`, in its thread when the fake holds it. */
    playBounce: (played: Report & { readonly status?: string; readonly action?: string }) => {
      const { status = BOUNCE_STATUS, action = FAILED_ACTION } = played;
      const original = byMessageId(fake, played.originalMessageId);
      const recipient = `Final-Recipient: rfc822; ${toOf(original) ?? FAKE_LEAD}`;
      const content = `Reporting-MTA: dns; ${FAKE_MESSAGE_DOMAIN}\r\n\r\n${recipient}\r\nAction: ${action}\r\nStatus: ${status}`;
      return report(fake, original, played.originalMessageId, "delivery-status", content);
    },
    /** A feedback report (RFC 5965) for the message under `originalMessageId`. */
    playComplaint: (played: Report & { readonly feedbackType?: string }): PlayedMessage => {
      const original = byMessageId(fake, played.originalMessageId);
      const type = played.feedbackType ?? FEEDBACK_TYPE;
      const content = `Feedback-Type: ${type}\r\nUser-Agent: whytide-fake/1\r\nVersion: 1`;
      return report(fake, original, played.originalMessageId, "feedback-report", content);
    },
    /** A mail to the mailbox under the subject given, as a mailto: unsubscribe link sends one. */
    playUnsubscribe: (played: Play & { readonly subject: string }): PlayedMessage =>
      play(fake, { From: played.from ?? FAKE_LEAD, Subject: played.subject }, ""),
    /** A message outside every platform thread, in a thread of its own: someone's personal mail. */
    playPersonal: (played: Play = {}): PlayedMessage => {
      const {
        from = FAKE_FRIEND,
        subject = PLAYED.personalSubject,
        text = PLAYED.personalText,
      } = played;
      return play(fake, { From: from, Subject: subject }, text);
    },
    /** Every grant so far is gone, as when the person removes the app's access: their calls answer mailbox_token_revoked. */
    revoke: (): void => {
      for (const { grant } of fake.state.tokens.values()) grant.revoked = true;
    },
    /** The next send is kept and findable, then answers the code; several queue up. */
    failAfterSendNext: (code: Code, details?: Record<string, unknown>): void => {
      if (!Object.hasOwn(errors, code)) {
        const reason = "a code the port does not declare";
        throw new AppError(patternErrors.adapter_invalid, { details: { port: "mailbox", reason } });
      }
      fake.state.afterSend.push({ code, details: withRetry(code, details) });
    },
    /** The next findSent answers found: false, as a provider that has not indexed the send yet. */
    findMissesNext: (): void => {
      fake.state.findMisses += 1;
    },
  }),
});

export type MailboxFake = typeof mailboxFake;

// failNext("mailbox_rate_limited") carries retryAfterSec, as every adapter's rate limit does.
const failNext = mailboxFake.failNext;
mailboxFake.failNext = (code, details) => failNext(code, withRetry(code, details));

export const mailboxFakeAdapter = defineAdapter(mailboxPort, {
  name: "fake",
  create: () => {
    if (platformConfig.APP_ENV === "production") {
      const details = { port: mailboxPort.name, adapter: "fake", reason: "APP_ENV=production" };
      throw new AppError(patternErrors.adapter_invalid, { details });
    }
    return mailboxFake;
  },
});

function withRetry(code: string, details: Details): Details {
  return code === errors.mailbox_rate_limited
    ? { retryAfterSec: RETRY_AFTER_SEC, ...details }
    : details;
}

/** A refresh and an access token for the grant. */
function issue(fake: Context, grant: Grant) {
  const refreshToken = `${PREFIX.refresh}${randomUUID()}`;
  const accessToken = `${PREFIX.access}${randomUUID()}`;
  const accessExpiresAt = new Date(Date.now() + ACCESS_TTL_SECONDS * 1000);
  const until = accessExpiresAt.getTime();
  fake.state.tokens.set(refreshToken, { grant, kind: "refresh", until: Number.POSITIVE_INFINITY });
  fake.state.tokens.set(accessToken, { grant, kind: "access", until });
  return { refreshToken, accessToken, accessExpiresAt };
}

/** The token's grant: a revoked one, or an unknown refresh token, is gone; an unknown or old access token expired. */
function grantOf(fake: Context, token: string, kind: Token["kind"], scope?: MailboxScope): Grant {
  const found = fake.state.tokens.get(token);
  if (found?.grant.revoked) throw new AppError(errors.mailbox_token_revoked);
  if (found?.kind !== kind || found.until <= Date.now()) {
    const code = kind === "refresh" ? errors.mailbox_token_revoked : errors.mailbox_access_expired;
    throw new AppError(code);
  }
  if (scope !== undefined && !found.grant.scopes.includes(scope))
    throw new AppError(errors.mailbox_scope_missing);
  return found.grant;
}

const inMailbox = (fake: Context, mailbox: string) =>
  fake.state.messages.filter((message) => message.mailbox === mailbox);

/** The message the fake holds under the Message-ID, in the latest connection's mailbox. */
const byMessageId = (fake: Context, messageId: string) =>
  inMailbox(fake, fake.state.mailbox).find((message) => message.head.messageId === messageId);

/** The address a message was sent to. */
const toOf = (message: Stored | undefined) =>
  message && addressIn(valuesOf(readText(message.raw).fields ?? [], FIELD_NAMES.to)[0]);

/** Keeps the raw message in the mailbox, after every message before it, in the thread given or a new one. */
function store(fake: Context, mailbox: string, raw: string, threadRef?: string): MessageHead {
  const { messages } = fake.state;
  // Strictly later than the last: date order is arrival order.
  const at = new Date(Math.max(Date.now(), (messages.at(-1)?.head.at.getTime() ?? 0) + 1));
  // Only what an adapter asks the provider for before the body.
  const fields = (readText(raw).fields ?? []).filter(({ name }) => HEAD_FIELDS.includes(name));
  const head = headOf({
    messageRef: `${PREFIX.message}${randomUUID()}`,
    threadRef: threadRef ?? `${PREFIX.thread}${randomUUID()}`,
    at,
    fields,
  });
  messages.push({ seq: messages.length + 1, mailbox, head, raw });
  return head;
}

/** A played message, to the mailbox: in the thread of the message it answers, else the one given or a new one. */
function play(
  fake: Context,
  given: Record<string, string>,
  body: string,
  { into, threadRef, messageId = `${randomUUID()}@${FAKE_MESSAGE_DOMAIN}` }: Placed = {},
): PlayedMessage {
  const mailbox = into?.mailbox ?? fake.state.mailbox;
  const fields = {
    To: mailbox,
    Date: new Date().toUTCString(),
    "Message-ID": `<${messageId}>`,
    "MIME-Version": "1.0",
    "Content-Type": "text/plain; charset=utf-8",
    ...given,
  };
  const lines = Object.entries(fields).map(([name, value]) => `${name}: ${value}`);
  const head = store(
    fake,
    mailbox,
    [...lines, "", body].join("\r\n"),
    into?.head.threadRef ?? threadRef,
  );
  return { messageRef: head.messageRef, threadRef: head.threadRef, messageId };
}

/** A multipart/report of the type: its reader's text, the report and the original's Message-ID. */
function report(
  fake: Context,
  into: Stored | undefined,
  originalMessageId: string,
  type: "delivery-status" | "feedback-report",
  content: string,
): PlayedMessage {
  const parts = [
    ["text/plain; charset=utf-8", PLAYED.reportText],
    [`message/${type}`, content],
    ["text/rfc822-headers", `Message-ID: <${originalMessageId}>`],
  ].map(([partType, text]) => `--${REPORT_BOUNDARY}\r\nContent-Type: ${partType}\r\n\r\n${text}`);
  const fields = {
    From: `Mail Delivery Subsystem <${FAKE_MAILER}>`,
    Subject: type === "delivery-status" ? PLAYED.bounceSubject : PLAYED.complaintSubject,
    "Content-Type": `multipart/report; report-type=${type}; boundary="${REPORT_BOUNDARY}"`,
  };
  return play(fake, fields, [...parts, `--${REPORT_BOUNDARY}--`, ""].join("\r\n"), { into });
}

/** The events the matcher gives for the messages, read as an adapter reads them: the head, then the whole. */
function eventsOf(matcher: MailboxMatcher, messages: readonly Stored[]): MailboxEvent[] {
  return messages.flatMap(({ head, raw }) => {
    const event = matcher.mayMatch(head) ? matcher.eventOf(head, raw) : undefined;
    return event === undefined ? [] : [event];
  });
}

const cursorOf = (seq: number) => Buffer.from(`${PREFIX.cursor}${seq}`).toString("base64url");

/** The place a cursor of the fake's names; any other, or one past the last message, is mailbox_cursor_invalid. */
function seqOf(cursor: string, latest: number): number {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const digits = text.startsWith(PREFIX.cursor) ? text.slice(PREFIX.cursor.length) : "";
  const seq = /^\d{1,15}$/.test(digits) ? Number(digits) : Number.NaN;
  if (!(seq <= latest)) throw new AppError(errors.mailbox_cursor_invalid);
  return seq;
}
