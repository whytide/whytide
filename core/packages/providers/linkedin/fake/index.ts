// The LinkedIn fake (README.md "The fake"): accounts, posts and profiles in memory, enough to run the
// signal flow and the smoke test without a vendor. Its hosted links point at CONNECT_PATH on the
// host that mounts connectOnVisit(), a route served under APP_ENV=test only: a visit connects a new
// account, emits the account.connected webhook and sends the browser to the success URL. Its
// webhooks carry an HMAC-SHA256 of the raw body under a secret drawn at start, which nothing logs.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError, platformConfig } from "@whytide/platform";
import { z } from "zod";
import { createFake, defineAdapter, type FakeContext } from "../../_pattern/index.ts";
import {
  type AccountStatus,
  type Engager,
  LINKEDIN_WEBHOOK_KINDS,
  type LinkedinWebhook,
  type LinkedinWebhookEvent,
  linkedinPort,
  type Profile,
} from "../port.ts";

/** The test-mode route a hosted link of the fake points at, `?link=<providerRef>`. */
export const CONNECT_PATH = "/api/linkedin/fake/connect";
/** The header of the fake's webhooks: `sha256=<hex HMAC-SHA256 of the raw body>`. */
export const SIGNATURE_HEADER = "x-linkedin-fake-signature";
/** The seconds a rate limit asks to wait when failNext gives none. */
export const RETRY_AFTER_SEC = 60;

/** The route is served under APP_ENV=test exactly: never in development, never in production. */
const TEST_MODE = platformConfig.APP_ENV === "test";
const SECRET = randomBytes(32);
const { errors } = linkedinPort;
const STATUS_OF = {
  "account.connected": "connected",
  "account.disconnected": "disconnected",
  "account.credentials_required": "credentials_required",
} as const satisfies Record<LinkedinWebhookEvent["kind"], AccountStatus["status"]>;
/** The body of the fake's webhooks, its vendor format. */
const webhookBody = z.strictObject({
  type: z.enum(LINKEDIN_WEBHOOK_KINDS),
  account: z.string().min(1),
  link: z.string().min(1).optional(),
});

type Link = {
  readonly successUrl: string;
  readonly failureUrl: string;
  readonly expiresAt: number;
};
type State = {
  /** Links not visited yet, by providerRef. */
  readonly links: Map<string, Link>;
  readonly accounts: Map<string, AccountStatus["status"]>;
  readonly posts: Map<string, readonly Engager[]>;
  readonly profiles: Map<string, Omit<Profile, "fetchedAt">>;
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
      return { status, checkedAt: new Date() };
    },
    listPostEngagers: async ({ providerAccountRef, postUrl, cursor, limit }) => {
      readable(fake, providerAccountRef);
      const engagers = fake.state.posts.get(postUrl);
      if (!engagers) throw new AppError(errors.linkedin_not_found);
      const start = cursor === undefined ? 0 : offsetOf(cursor);
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
    parseWebhook: async ({ headers, rawBody }) => {
      const given = Object.entries(headers).find(
        ([name]) => name.toLowerCase() === SIGNATURE_HEADER,
      );
      if (!signatureMatches(rawBody, given?.[1])) throw webhookInvalid("signature");
      const body = webhookBody.safeParse(jsonOf(rawBody));
      if (!body.success) throw webhookInvalid("body");
      const { type: kind, account: providerAccountRef, link } = body.data;
      return link === undefined
        ? { kind, providerAccountRef }
        : { kind, providerAccountRef, providerRef: link };
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
    emitWebhook: (kind: LinkedinWebhookEvent["kind"], providerAccountRef: string) =>
      emit(fake, { kind, providerAccountRef }),
    /** The handler serving CONNECT_PATH under APP_ENV=test; `deliver` gets each visit's webhook. */
    connectOnVisit: (deliver?: WebhookDelivery): LinkedinFakeHandler => handler(fake, deliver),
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
  create: () => linkedinFake,
});

/** The account reads: unknown is linkedin_not_found, not connected linkedin_account_disconnected. */
function readable(fake: Context, providerAccountRef: string): void {
  const status = fake.state.accounts.get(providerAccountRef);
  if (status === undefined) throw new AppError(errors.linkedin_not_found);
  if (status !== "connected") throw new AppError(errors.linkedin_account_disconnected);
}

const cursorOf = (offset: number) => Buffer.from(`offset:${offset}`).toString("base64url");

function offsetOf(cursor: string): number {
  const offset = /^offset:(\d{1,9})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"))?.[1];
  if (offset === undefined) {
    const details = { method: "listPostEngagers", reason: "a cursor the fake did not give" };
    throw new AppError(linkedinPort.codes.input, { details });
  }
  return Number(offset);
}

const sign = (rawBody: string | Uint8Array) =>
  `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`;

/** Compared in constant time; a missing or repeated header never matches. */
function signatureMatches(rawBody: string | Uint8Array, given: unknown): boolean {
  if (typeof given !== "string") return false;
  const [expected, actual] = [Buffer.from(sign(rawBody)), Buffer.from(given)];
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function jsonOf(rawBody: string | Uint8Array): unknown {
  try {
    return JSON.parse(
      typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8"),
    );
  } catch {
    return undefined;
  }
}

/** Nothing of the body or the secret in it. */
const webhookInvalid = (reason: string) =>
  new AppError(errors.linkedin_webhook_invalid, { details: { method: "parseWebhook", reason } });

function emit(fake: Context, event: LinkedinWebhookEvent): LinkedinWebhook {
  fake.state.accounts.set(event.providerAccountRef, STATUS_OF[event.kind]);
  const link = event.providerRef === undefined ? {} : { link: event.providerRef };
  const rawBody = JSON.stringify({ type: event.kind, account: event.providerAccountRef, ...link });
  return {
    headers: { "content-type": "application/json", [SIGNATURE_HEADER]: sign(rawBody) },
    rawBody,
  };
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
  await deliver?.(emit(fake, { kind: "account.connected", providerAccountRef, providerRef }));
  return link.successUrl;
}
