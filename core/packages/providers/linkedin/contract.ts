// The LinkedIn port's contract (README.md "The contract suite"): what every adapter does, run by
// each adapter's tests/contract.test.ts with a LinkedinWorld, the adapter's side of the cases: how
// a user connects through a hosted link, a post and a profile the account can read, the vendor's
// signed webhooks and, when the vendor can be made to send one, its rate limit; for the send cases,
// a member to invite or a relation to message, and a disconnected account; for the event cases, a
// signed event of each kind (README.md "Events"). The fake's world seeds all of it; a vendor's world
// points at its sandbox, and a case skips where it gives no recipient, no events or none of a kind
// the vendor never sends. A run sends at most one invitation, withdrawn at once, and one message.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { isAppError } from "@whytide/platform";
import type { PortInstance } from "../_pattern/index.ts";
import type { ContractCases } from "../testing/index.ts";
import {
  type HostedAuthLink,
  LINKEDIN_DISCONNECT_REASONS,
  LINKEDIN_WEBHOOK_KINDS,
  type LinkedinWebhook,
  type LinkedinWebhookEvent,
  type linkedinPort,
  type PendingInvite,
  type Profile,
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
/** Pages of pending invitations read at most: a cursor that loops stops here. */
const PAGES_AT_MOST = 50;

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

export const linkedinCases = (world: LinkedinWorld): ContractCases<typeof linkedinPort> => ({
  ...eventCases(world),
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
    const calls = {
      listPostEngagers: () =>
        linkedin.listPostEngagers({ providerAccountRef, postUrl: UNKNOWN_POST, limit: 10 }),
      getRelation: () => linkedin.getRelation(member),
      listPendingInvites: () => linkedin.listPendingInvites({ providerAccountRef }),
      listRecentMessages: () => linkedin.listRecentMessages({ ...member, since: new Date() }),
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
