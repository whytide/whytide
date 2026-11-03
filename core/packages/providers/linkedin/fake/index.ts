// The LinkedIn fake (README.md "The fake"): accounts, posts and profiles in memory, enough to run
// the signal flow and the smoke test without a vendor, and each account's network for the sends:
// its pending invitations by member, its relations and its chats, whose messages hold refs and
// times, never text. It ignores the idempotency key, as Unipile does: a repeated send is a second
// call, so that a caller that sends twice shows two recorded calls. Its hosted links point at
// CONNECT_PATH on the host that mounts connectOnVisit(), a route served under APP_ENV=test only: a
// visit connects a new account, emits the account.connected webhook and sends the browser to the
// success URL. Its webhooks are webhooks.ts's, signed, its helpers emit every kind the port reads
// (README.md "Events"), each changing the fake's state as its event says, and every account has a
// member id of its own, derived from its ref. create() refuses APP_ENV=production: the fake never
// stands in for LinkedIn on a server.
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError, platformConfig } from "@whytide/platform";
import {
  createFake,
  defineAdapter,
  type FakeContext,
  patternErrors,
} from "../../_pattern/index.ts";
import {
  type AccountStatus,
  type AccountStatusEvent,
  type Engager,
  type LinkedinWebhook,
  type LinkedinWebhookEvent,
  linkedinPort,
  type Profile,
  type RecentMessage,
} from "../port.ts";
import {
  ACCEPTANCE_PREFIX,
  MESSAGE_PREFIX,
  PENDING_INVITES_PAGE,
  SELF_MEMBER_HEX_DIGITS,
  SELF_MEMBER_PREFIX,
} from "./constants.ts";
import { forged, signed, verifiedEvent } from "./webhooks.ts";

export { SIGNATURE_HEADER } from "./constants.ts";

/** The test-mode route a hosted link of the fake points at, `?link=<providerRef>`. */
export const CONNECT_PATH = "/api/linkedin/fake/connect";
/** The seconds a rate limit asks to wait when failNext gives none. */
export const RETRY_AFTER_SEC = 60;

/** The route is served under APP_ENV=test exactly: never in development, never in production. */
const TEST_MODE = platformConfig.APP_ENV === "test";
const { errors } = linkedinPort;
/** An account's state: an account.status event's, each but `connected` a disconnect reason. */
type Status = AccountStatusEvent["status"];
/** alpha's account kinds, which emitWebhook takes, and the status each leaves the account in. */
const STATUS_OF = {
  "account.connected": "connected",
  "account.disconnected": "disconnected",
  "account.credentials_required": "credentials_required",
} as const satisfies Partial<Record<LinkedinWebhookEvent["kind"], Status>>;
type AccountKind = keyof typeof STATUS_OF;
/** What getAccountStatus answers: `error` for a warning, as Unipile's for a source neither OK nor CREDENTIALS. */
const ANSWER_OF: Readonly<Record<Status, AccountStatus["status"]>> = {
  connected: "connected",
  credentials_required: "credentials_required",
  checkpoint: "error",
  restricted: "error",
  disconnected: "disconnected",
};

type Link = {
  readonly successUrl: string;
  readonly failureUrl: string;
  readonly expiresAt: number;
};
type Chat = { readonly memberRef: string; readonly messages: RecentMessage[] };
/** A message emitMessage reports, to or from the member. */
export type FakeMessage = {
  readonly memberRef: string;
  /** The chat it joins, opened under this ref when new; absent, the member's own, found or opened. */
  readonly chatRef?: string;
  readonly text: string;
  /** Sent by the account itself; false, the default, for the member's message to it. */
  readonly fromAccount?: boolean;
};
/** An account's side of LinkedIn, made on first use. */
type Network = {
  /** Pending invitations, by member. */
  readonly invitations: Map<string, { readonly invitationRef: string; readonly sentAt: Date }>;
  readonly relations: Set<string>;
  /** Chats, by chatRef. */
  readonly chats: Map<string, Chat>;
};
type State = {
  /** Links not visited yet, by providerRef. */
  readonly links: Map<string, Link>;
  readonly accounts: Map<string, Status>;
  readonly posts: Map<string, readonly Engager[]>;
  readonly profiles: Map<string, Omit<Profile, "fetchedAt">>;
  /** Each account's network, by providerAccountRef. */
  readonly networks: Map<string, Network>;
};
type Context = FakeContext<typeof linkedinPort, State>;
/** A connect-style handler: Express, NestJS's app.use and a plain node:http server mount it. */
export type LinkedinFakeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void;
/** Where a visit's account.connected webhook goes: the host's webhook route, say. */
export type WebhookDelivery = (webhook: LinkedinWebhook) => Promise<unknown>;

export const linkedinFake = createFake(linkedinPort, {
  state: (): State => ({
    links: new Map(),
    accounts: new Map(),
    posts: new Map(),
    profiles: new Map(),
    networks: new Map(),
  }),
  methods: (fake) => ({
    createHostedAuthLink: async ({ successUrl, failureUrl, expiresInMin }) => {
      const providerRef = `fake-link-${randomUUID()}`;
      const expiresAt = new Date(Date.now() + expiresInMin * 60_000);
      fake.state.links.set(providerRef, { successUrl, failureUrl, expiresAt: expiresAt.getTime() });
      // On the success page's origin, which the host mounting connectOnVisit serves too.
      const url = new URL(`${CONNECT_PATH}?link=${providerRef}`, successUrl).href;
      return { url, expiresAt, providerRef };
    },
    getAccountStatus: async (providerAccountRef) => {
      const status = fake.state.accounts.get(providerAccountRef);
      if (status === undefined) throw new AppError(errors.linkedin_not_found);
      const memberRef = selfMemberRef(providerAccountRef);
      return { status: ANSWER_OF[status], checkedAt: new Date(), memberRef };
    },
    listPostEngagers: async ({ providerAccountRef, postUrl, cursor, limit }) => {
      readable(fake, providerAccountRef);
      const engagers = fake.state.posts.get(postUrl);
      if (!engagers) throw new AppError(errors.linkedin_not_found);
      const start = cursor === undefined ? 0 : offsetOf(cursor, "listPostEngagers");
      const end = start + limit;
      const nextCursor = end < engagers.length ? cursorOf(end) : null;
      return { engagers: structuredClone(engagers.slice(start, end)), nextCursor };
    },
    getProfile: async ({ providerAccountRef, profileUrl }) => {
      readable(fake, providerAccountRef);
      const profile = fake.state.profiles.get(profileUrl);
      if (!profile) throw new AppError(errors.linkedin_not_found);
      return { ...structuredClone(profile), fetchedAt: new Date() };
    },
    parseWebhook: async (webhook) => verifiedEvent(webhook),
    sendInvite: async ({ providerAccountRef, memberRef }) => {
      const network = connectedNetwork(fake, providerAccountRef);
      if (network.relations.has(memberRef)) throw refused("sendInvite", "already_connected");
      if (network.invitations.has(memberRef)) throw refused("sendInvite", "already_invited");
      const sentAt = new Date();
      const invitationRef = `fake-invitation-${randomUUID()}`;
      network.invitations.set(memberRef, { invitationRef, sentAt });
      return { invitationRef, sentAt: new Date(sentAt) };
    },
    sendMessage: async ({ providerAccountRef, memberRef, chatRef }) => {
      const network = connectedNetwork(fake, providerAccountRef);
      if (!network.relations.has(memberRef)) throw refused("sendMessage", "not_connected");
      const [ref, chat] =
        chatOf(network, memberRef, chatRef, "sendMessage") ?? opened(network, memberRef);
      const message = {
        messageRef: `${MESSAGE_PREFIX}${randomUUID()}`,
        chatRef: ref,
        fromAccount: true,
        sentAt: new Date(),
      };
      chat.messages.push(message);
      return { messageRef: message.messageRef, chatRef: ref, sentAt: new Date(message.sentAt) };
    },
    withdrawInvite: async ({ providerAccountRef, invitationRef }) => {
      const { invitations } = connectedNetwork(fake, providerAccountRef);
      const pending = [...invitations].find(([, sent]) => sent.invitationRef === invitationRef);
      if (pending === undefined) throw notFound("withdrawInvite");
      invitations.delete(pending[0]);
      return { withdrawnAt: new Date() };
    },
    listPendingInvites: async ({ providerAccountRef, cursor }) => {
      const { invitations } = connectedNetwork(fake, providerAccountRef);
      const invites = [...invitations].map(([memberRef, { invitationRef, sentAt }]) => ({
        invitationRef,
        memberRef,
        sentAt: new Date(sentAt),
      }));
      const start = cursor === undefined ? 0 : offsetOf(cursor, "listPendingInvites");
      const end = start + PENDING_INVITES_PAGE;
      const nextCursor = end < invites.length ? cursorOf(end) : null;
      return { invites: invites.slice(start, end), nextCursor };
    },
    listRecentMessages: async ({ providerAccountRef, memberRef, chatRef, since }) => {
      const network = connectedNetwork(fake, providerAccountRef);
      const [, chat] = chatOf(network, memberRef, chatRef, "listRecentMessages") ?? [];
      const messages = (chat?.messages ?? [])
        .filter(({ sentAt }) => sentAt.getTime() >= since.getTime())
        .toSorted((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
        .map((message) => ({ ...message, sentAt: new Date(message.sentAt) }));
      return { messages };
    },
    getRelation: async ({ providerAccountRef, memberRef }) => {
      const { relations, invitations } = connectedNetwork(fake, providerAccountRef);
      return { connected: relations.has(memberRef), invitationPending: invitations.has(memberRef) };
    },
  }),
  helpers: (fake) => ({
    /** The post's engagers, which listPostEngagers pages newest first, ties in the order given. */
    seedPost: (postUrl: string, engagers: readonly Engager[]): void =>
      void fake.state.posts.set(
        postUrl,
        structuredClone(engagers).toSorted((a, b) => b.engagedAt.getTime() - a.engagedAt.getTime()),
      ),
    /** A profile getProfile returns, fetchedAt set at each read. */
    seedProfile: (profile: Omit<Profile, "fetchedAt">): void =>
      void fake.state.profiles.set(profile.profileUrl, structuredClone(profile)),
    /** The account changes state, created if need be, and the vendor's signed webhook says so. */
    emitWebhook: (kind: AccountKind, providerAccountRef: string): LinkedinWebhook =>
      emitAccount(fake, kind, providerAccountRef),
    /** The account takes the status, created if need be, and its signed account.status says so. */
    emitAccountStatus: (providerAccountRef: string, status: Status): LinkedinWebhook => {
      fake.state.accounts.set(providerAccountRef, status);
      return signed({ type: "account.status", account: providerAccountRef, status });
    },
    /**
     * The member accepts: the pending invitation, if any, becomes a relation, as acceptInvite's does,
     * and the signed invite.accepted says so, under a new eventKey; with none pending, a relation all
     * the same, as one the user accepted by hand is.
     */
    emitAccepted: (providerAccountRef: string, memberRef: string): LinkedinWebhook => {
      const { invitations, relations } = networkOf(fake, providerAccountRef);
      invitations.delete(memberRef);
      relations.add(memberRef);
      const id = `${ACCEPTANCE_PREFIX}${randomUUID()}`;
      const at = new Date().toISOString();
      return signed({
        type: "invite.accepted",
        account: providerAccountRef,
        id,
        member: memberRef,
        at,
      });
    },
    /**
     * A message joins the chat, as refs and its time, so listRecentMessages reads it, and the signed
     * message.received carries its text: the fake keeps none.
     */
    emitMessage: (providerAccountRef: string, message: FakeMessage): LinkedinWebhook => {
      const { memberRef, chatRef, text, fromAccount = false } = message;
      const [ref, chat] = joinedChat(networkOf(fake, providerAccountRef), memberRef, chatRef);
      const sent = { messageRef: `${MESSAGE_PREFIX}${randomUUID()}`, chatRef: ref, fromAccount };
      const sentAt = new Date();
      chat.messages.push({ ...sent, sentAt });
      return signed({
        type: "message.received",
        account: providerAccountRef,
        id: sent.messageRef,
        chat: ref,
        sender: fromAccount ? selfMemberRef(providerAccountRef) : memberRef,
        from_account: fromAccount,
        attendees: [memberRef],
        text,
        sent_at: sentAt.toISOString(),
      });
    },
    /** A copy of the webhook, of any kind, whose signature is wrong; the webhook is left as it was. */
    forge: (webhook: LinkedinWebhook): LinkedinWebhook => forged(webhook),
    /** The handler serving CONNECT_PATH under APP_ENV=test; `deliver` gets each visit's webhook. */
    connectOnVisit: (deliver?: WebhookDelivery): LinkedinFakeHandler => handler(fake, deliver),
    /** The member accepts the pending invitation, now a relation; none is linkedin_not_found. */
    acceptInvite: (providerAccountRef: string, memberRef: string): void => {
      const { invitations, relations } = networkOf(fake, providerAccountRef);
      if (!invitations.delete(memberRef)) {
        const details = { helper: "acceptInvite", reason: "no invitation pending" };
        throw new AppError(errors.linkedin_not_found, { details });
      }
      relations.add(memberRef);
    },
    /** The member is a relation of the account's already, with no invitation pending. */
    seedRelation: (providerAccountRef: string, memberRef: string): void => {
      const { invitations, relations } = networkOf(fake, providerAccountRef);
      invitations.delete(memberRef);
      relations.add(memberRef);
    },
  }),
});

export type LinkedinFake = typeof linkedinFake;

// failNext("linkedin_rate_limited") carries retryAfterSec, as every adapter's rate limit does.
const failNext = linkedinFake.failNext;
linkedinFake.failNext = (code, details) =>
  failNext(
    code,
    code === errors.linkedin_rate_limited
      ? { retryAfterSec: RETRY_AFTER_SEC, ...details }
      : details,
  );

export const linkedinFakeAdapter = defineAdapter(linkedinPort, {
  name: "fake",
  create: () => {
    if (platformConfig.APP_ENV === "production") {
      const details = { port: linkedinPort.name, adapter: "fake", reason: "APP_ENV=production" };
      throw new AppError(patternErrors.adapter_invalid, { details });
    }
    return linkedinFake;
  },
});

/** An account that reads or sends: unknown is linkedin_not_found, else disconnected with the reason. */
function readable(fake: Context, providerAccountRef: string): void {
  const status = fake.state.accounts.get(providerAccountRef);
  if (status === undefined) throw new AppError(errors.linkedin_not_found);
  if (status === "connected") return;
  throw new AppError(errors.linkedin_account_disconnected, { details: { reason: status } });
}

/** The account's own member id, the same in every process: derived from its ref. */
function selfMemberRef(providerAccountRef: string): string {
  const digest = createHash("sha256").update(providerAccountRef).digest("hex");
  return `${SELF_MEMBER_PREFIX}${digest.slice(0, SELF_MEMBER_HEX_DIGITS)}`;
}

/** The account's network, made on first use; the helpers seed it whatever the account's status. */
function networkOf(fake: Context, providerAccountRef: string): Network {
  const found = fake.state.networks.get(providerAccountRef);
  if (found) return found;
  const network: Network = { invitations: new Map(), relations: new Set(), chats: new Map() };
  fake.state.networks.set(providerAccountRef, network);
  return network;
}

/** A connected account's network, for the send-side methods. */
function connectedNetwork(fake: Context, providerAccountRef: string): Network {
  readable(fake, providerAccountRef);
  return networkOf(fake, providerAccountRef);
}

/** The chat given, which must be the member's (else linkedin_not_found), or the member's own. */
function chatOf(
  network: Network,
  memberRef: string,
  chatRef: string | undefined,
  method: string,
): [string, Chat] | undefined {
  if (chatRef === undefined) {
    return [...network.chats].find(([, chat]) => chat.memberRef === memberRef);
  }
  const chat = network.chats.get(chatRef);
  if (chat === undefined || chat.memberRef !== memberRef) throw notFound(method);
  return [chatRef, chat];
}

/** A new chat with the member, under the ref given or a new one. */
function opened(
  network: Network,
  memberRef: string,
  chatRef = `fake-chat-${randomUUID()}`,
): [string, Chat] {
  const chat: Chat = { memberRef, messages: [] };
  network.chats.set(chatRef, chat);
  return [chatRef, chat];
}

/** The chat emitMessage's message joins: the one given, which must be the member's, or the member's own. */
function joinedChat(network: Network, memberRef: string, chatRef?: string): [string, Chat] {
  if (chatRef === undefined)
    return chatOf(network, memberRef, undefined, "emitMessage") ?? opened(network, memberRef);
  const chat = network.chats.get(chatRef);
  if (chat === undefined) return opened(network, memberRef, chatRef);
  if (chat.memberRef !== memberRef) {
    const details = { helper: "emitMessage", reason: "a chat of another member" };
    throw new AppError(errors.linkedin_not_found, { details });
  }
  return [chatRef, chat];
}

const notFound = (method: string) =>
  new AppError(errors.linkedin_not_found, { details: { method } });
/** A permanent refusal: already connected, already invited, not connected for a message. */
const refused = (method: string, reason: string) =>
  new AppError(errors.linkedin_send_refused, { details: { method, reason } });

const cursorOf = (offset: number) => Buffer.from(`offset:${offset}`).toString("base64url");

function offsetOf(cursor: string, method: string): number {
  const offset = /^offset:(\d{1,9})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"))?.[1];
  if (offset === undefined) {
    const details = { method, reason: "a cursor the fake did not give" };
    throw new AppError(linkedinPort.codes.input, { details });
  }
  return Number(offset);
}

/** The account takes the kind's status, created if need be, and the signed webhook says so. */
function emitAccount(
  fake: Context,
  kind: AccountKind,
  providerAccountRef: string,
  providerRef?: string,
): LinkedinWebhook {
  fake.state.accounts.set(providerAccountRef, STATUS_OF[kind]);
  const account = providerAccountRef;
  if (kind !== "account.connected") return signed({ type: kind, account });
  return signed({
    type: kind,
    account,
    ...(providerRef === undefined ? {} : { link: providerRef }),
  });
}

/** GET CONNECT_PATH under APP_ENV=test; any other request, and an unknown or used link, goes on. */
function handler(fake: Context, deliver: WebhookDelivery | undefined): LinkedinFakeHandler {
  return (req, res, next) => {
    const url = URL.parse(req.url ?? "/", "http://fake.invalid");
    if (!TEST_MODE || url?.pathname !== CONNECT_PATH || req.method !== "GET") return next();
    visit(fake, url.searchParams.get("link") ?? "", deliver).then(
      (location) => {
        if (location === undefined) return next();
        if (res.headersSent) return; // the host answered already, on a timeout say
        const policy = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
        res.writeHead(303, { location, ...policy }).end();
      },
      (error: unknown) => {
        if (!res.headersSent) next(error);
      },
    );
  };
}

/** Where the visit sends the browser: success once connected, failure for an expired link. */
async function visit(
  fake: Context,
  providerRef: string,
  deliver: WebhookDelivery | undefined,
): Promise<string | undefined> {
  const link = fake.state.links.get(providerRef);
  fake.state.links.delete(providerRef); // a link works once
  if (!link) return undefined;
  if (link.expiresAt <= Date.now()) return link.failureUrl;
  const providerAccountRef = `fake-account-${randomUUID()}`;
  await deliver?.(emitAccount(fake, "account.connected", providerAccountRef, providerRef));
  return link.successUrl;
}
