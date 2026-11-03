// The LinkedIn port's contract (README.md "The contract suite"): what every adapter does, run by each
// adapter's tests/contract.test.ts with a LinkedinWorld, the adapter's side of the cases: how a user
// connects through a hosted link, a post and a profile the account can read, the vendor's signed
// webhooks and, when the vendor can be made to send one, its rate limit. The fake's world seeds all
// of it; a vendor's world points at its sandbox.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { isAppError } from "@whytide/platform";
import type { PortInstance } from "../_pattern/index.ts";
import type { ContractCases } from "../testing/index.ts";
import type {
  HostedAuthLink,
  LinkedinWebhook,
  LinkedinWebhookEvent,
  linkedinPort,
  Profile,
} from "./port.ts";

type Linkedin = PortInstance<typeof linkedinPort>;

/** Where every case's hosted link sends the user back. */
export const RETURN_URLS = {
  successUrl: "https://app.whytide.test/w/acme/linkedin/connected",
  failureUrl: "https://app.whytide.test/w/acme/linkedin/failed",
} as const;

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
  webhook(event: LinkedinWebhookEvent, options?: { forged?: boolean }): Promise<LinkedinWebhook>;
  /** The vendor's next answer is a rate limit; absent when the vendor cannot be made to send one. */
  rateLimitNext?(): void;
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
  return { link, event: await linkedin.parseWebhook(await world.connect(link, t)) };
}

export const linkedinCases = (world: LinkedinWorld): ContractCases<typeof linkedinPort> => ({
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
    const postUrl = "https://www.linkedin.com/feed/update/urn:li:activity:1000000000000000000/";
    await assert.rejects(
      linkedin.listPostEngagers({ providerAccountRef, postUrl, limit: 10 }),
      failsWith("linkedin_not_found"),
    );
  },
});
