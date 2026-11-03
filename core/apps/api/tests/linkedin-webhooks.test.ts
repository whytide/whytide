// linkedin's webhook end to end (beta-p0-060; core/modules/linkedin/README.md "The webhook"): the
// host started with identity and linkedin on the fakes, in a schema of the worktree's database, on a
// rate-limit clock the test sets, answering POST /v1/linkedin/webhooks/fake on the fake's signed
// events: a kept message, a repeat and a dropped one, a forged one, an acceptance twice, a
// disconnected status, the host's limits and Redis down, and a second user connecting an account
// connected in the workspace already. No worker runs: a kept event waits in the outbox. It lives
// here: a module never imports a host.
import assert from "node:assert/strict";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { json } from "node:stream/consumers";
import { after, before, test } from "node:test";
import { createClient } from "@redis/client";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import {
  collectLogs,
  createLogger,
  loadMasterKeys,
  newMasterKey,
  servicePrincipal,
} from "@whytide/platform";
import {
  filesConfig,
  filesPort,
  getAdapter,
  type LinkedinFake,
  type LinkedinWebhook,
  linkedinPort,
} from "@whytide/providers";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import type { Api, StartOptions } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads, the hosted link's return address at each connect.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
// The webhook's limit per address, read as the host loads: its default, 120, whatever .env.local says.
delete process.env.RATE_LIMIT_WEBHOOK_PER_IP_PER_MIN;
const { start } = await import("../src/start.ts");
const { WINDOW_MS } = await import("../src/protection/rate-limit.ts");
// linkedin by its build's path, as src/modules.generated.ts loads it (linkedin-accounts.test.ts).
const build = new URL("../../../../modules/linkedin/dist/", import.meta.url);
type Linkedin = typeof import("../../../modules/linkedin/dist/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
const linkedin: Linkedin = await import(new URL("index.js", build).href);
const testing: LinkedinTesting = await import(new URL("testing/index.js", build).href);
const { createConnectedAccount, createOutreach, useHashKey, useLinkedinClient, useSecretKeys } =
  testing;

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
useLinkedinClient(app);
useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
/** The event keys' hash key, a test one, never a real one. */
const HASH_KEY = "linkedin-webhooks-test-key-0123456789";
useHashKey(HASH_KEY);
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
/** The account.connected notifies of the hosted links' visits, which a test posts itself. */
const notified: LinkedinWebhook[] = [];
// A minute no other run uses (tests/protection.test.ts), one second in.
const base = (Math.floor(Date.now() / WINDOW_MS) + randomInt(1_000, 1_000_000)) * WINDOW_MS;
let clock = base + 1_000;
let api: Api;

const options = (): StartOptions => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  return {
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "linkedin", load: () => import(new URL("index.js", build).href) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
    now: () => clock,
  };
};

before(async () => {
  const connect = fake.connectOnVisit(async (webhook) => void notified.push(webhook));
  api = await start({ ...options(), mount: [connect] });
});
after(() => api?.close());

type Answer = { status: number; body: any };

/** The vendor's call to a host: no cookie, no workspace. */
async function post({ headers, rawBody }: LinkedinWebhook, host = api): Promise<Answer> {
  const url = new URL("/v1/linkedin/webhooks/fake", host.url);
  const init = { method: "POST", headers: headers as Record<string, string>, body: rawBody };
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
const NO_CONTENT = { status: 204, body: undefined };

/** What the deliveries left in the workspace: receipts, outreach rows, events, message files. */
async function stored(workspaceId: string) {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  const listed = await files.list({ workspaceId, prefix: "raw/linkedin/messages/" });
  const rows = await app.outboxEntry.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
  });
  return {
    receipts: await app.linkedinEventReceipt.count(),
    outreach: await app.senderOutreach.findMany({ where: { workspaceId }, orderBy: { id: "asc" } }),
    events: rows.map(({ eventName, payload, deliveredAt, attempts }) => ({
      eventName,
      payload,
      deliveredAt,
      attempts,
    })),
    files: listed.files.map((file) => file.key),
  };
}

/** A connected account of the tenant's workspace, by its reference, and an outreach row of it. */
async function seeded(
  tenant: TestTenant,
  row: { providerMemberRef?: string; providerChatRef?: string } = { providerChatRef: "chat-ines" },
) {
  const ref = `fake-account-${randomUUID()}`;
  const workspaceId = tenant.workspace.id;
  const { id: accountId } = await createConnectedAccount(workspaceId, { providerAccountRef: ref });
  const outreach = await createOutreach(workspaceId, { senderAccountId: accountId, ...row });
  return { workspaceId, ref, accountId, outreach };
}

test("a message on an outreach row's chat is kept: 204, its file, one receipt, its event waiting in the outbox; delivered again, 204 and nothing more; a message of no row, 204 and nothing", async () => {
  const [a] = await createTwoWorkspaces();
  const { workspaceId, ref, accountId, outreach } = await seeded(a);
  const text = "Sounds good, Thursday then.";
  const webhook = fake.emitMessage(ref, { memberRef: "member-ines", chatRef: "chat-ines", text });
  assert.deepEqual(await post(webhook), NO_CONTENT);

  const { id: eventKey, sent_at } = JSON.parse(String(webhook.rawBody));
  const hash = createHmac("sha256", HASH_KEY).update(`event:fake:${eventKey}`).digest("hex");
  const key = `w/${workspaceId}/raw/linkedin/messages/${hash}.json`;
  const kept = await stored(workspaceId);
  assert.deepEqual([kept.files, kept.receipts], [[key], 1]);
  const payload = { sender_account_id: accountId, person_id: outreach.personId };
  assert.deepEqual(kept.events, [
    {
      eventName: "linkedin.message_received",
      payload: { ...payload, direction: "in", file_key: key },
      ...{ deliveredAt: null, attempts: 0 },
    },
  ]);
  assert.equal(kept.outreach[0]?.lastInboundAt?.toISOString(), sent_at);
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  const body = await json((await files.get({ workspaceId, key })).body);
  assert.equal(linkedin.messageFile.parse(body).text, text);

  assert.deepEqual(await post(webhook), NO_CONTENT);
  const friend = { memberRef: "member-hugo", chatRef: "chat-hugo", text: "Lunch on Sunday?" };
  assert.deepEqual(await post(fake.emitMessage(ref, friend)), NO_CONTENT);
  assert.deepEqual(await stored(workspaceId), kept);
});

test("a forged event is 401 linkedin_webhook_invalid: nothing stored, no file written", async () => {
  const [a] = await createTwoWorkspaces();
  const { workspaceId, ref } = await seeded(a, { providerMemberRef: "member-ines" });
  const before = await stored(workspaceId);
  const message = { memberRef: "member-ines", chatRef: "chat-ines", text: "Hello" };
  const invalid = {
    status: 401,
    body: {
      code: "linkedin_webhook_invalid",
      details: { method: "parseWebhook", reason: "signature" },
    },
  };
  assert.deepEqual(await post(fake.forge(fake.emitMessage(ref, message))), invalid);
  assert.deepEqual(await post(fake.forge(fake.emitAccepted(ref, "member-ines"))), invalid);
  assert.deepEqual(await stored(workspaceId), before);
});

test("an acceptance sets accepted_at and accepted_detected_at and publishes linkedin.invite_accepted once; its repeat and a later acceptance publish nothing", async () => {
  const [a] = await createTwoWorkspaces();
  const { workspaceId, ref, accountId, outreach } = await seeded(a, {
    providerMemberRef: "member-ines",
  });
  const accepted = fake.emitAccepted(ref, "member-ines");
  for (const webhook of [accepted, accepted, fake.emitAccepted(ref, "member-ines")]) {
    assert.deepEqual(await post(webhook), NO_CONTENT);
  }
  const { outreach: rows, events, receipts } = await stored(workspaceId);
  const detectedAt = rows[0]?.acceptedDetectedAt;
  assert.equal(rows[0]?.acceptedAt?.toISOString(), JSON.parse(String(accepted.rawBody)).at);
  assert.ok(detectedAt instanceof Date);
  const payload = { sender_account_id: accountId, person_id: outreach.personId };
  assert.deepEqual(events, [
    {
      eventName: "linkedin.invite_accepted",
      payload: { ...payload, detected_at: detectedAt.toISOString() },
      ...{ deliveredAt: null, attempts: 0 },
    },
  ]);
  assert.equal(receipts, 2);
});

test("a disconnected status, which the adapters map every unknown status to, sets the account disconnected, its health too (beta-p6-010); its next reserveReads is refused linkedin_account_disconnected", async () => {
  const [a] = await createTwoWorkspaces();
  const { workspaceId, ref, accountId } = await seeded(a);
  assert.deepEqual(await post(fake.emitAccountStatus(ref, "disconnected")), NO_CONTENT);
  const account = await app.senderAccount.findUniqueOrThrow({ where: { id: accountId } });
  assert.deepEqual([account.status, account.healthState], ["disconnected", "disconnected"]);
  const { events } = await stored(workspaceId);
  const disconnected = ["linkedin.sender_account_disconnected", { sender_account_id: accountId }];
  const [health] = await app.senderHealthEvent.findMany({ where: { senderId: accountId } });
  const payload = { sender_account_id: accountId, health_event_id: health?.id };
  // One run wrote both, at one transaction time: by name.
  assert.deepEqual(events.map((event) => [event.eventName, event.payload]).sort(), [
    ["linkedin.account_paused", payload],
    disconnected,
  ]);
  const tenant = { workspaceId, principal: servicePrincipal("linkedin_test") };
  const reserve = () => linkedin.reserveReads({ accountId, count: 1, kind: "read_profile" });
  assert.deepEqual(await withTenant(tenant, reserve, { client: app }), {
    refused: "linkedin_account_disconnected",
    retryAt: null,
  });
});

test("the host's limits: a body over 64 KiB is 413, Content-Encoding gzip 415, the 121st call of a minute from one address 429; with Redis unreachable, an event is still received", async () => {
  const [a] = await createTwoWorkspaces();
  const { workspaceId, ref } = await seeded(a);
  const message = { memberRef: "member-ines", chatRef: "chat-ines", text: "x".repeat(64 * 1024) };
  clock = base + 10 * WINDOW_MS + 1_000; // a minute of its own, after an empty one
  try {
    const large = fake.emitMessage(ref, message);
    assert.deepEqual(await post(large), { status: 413, body: { code: "payload_too_large" } });
    const small = fake.emitMessage(ref, { ...message, text: "Hello" });
    const gzip = { ...small, headers: { ...small.headers, "content-encoding": "gzip" } };
    assert.deepEqual(await post(gzip), { status: 415, body: { code: "invalid_request" } });
    const unsigned = { headers: { "content-type": "application/json" }, rawBody: "{}" };
    for (let call = 3; call <= 120; call++) assert.equal((await post(unsigned)).status, 401);
    assert.deepEqual(await post(unsigned), { status: 429, body: { code: "rate_limited" } });
    assert.deepEqual((await stored(workspaceId)).events, []);

    // Redis does not answer: the limit lets the call through, and the event is kept.
    const redis = createClient({ url: "redis://127.0.0.1:1", disableOfflineQueue: true });
    const down = await start({ ...options(), redis });
    try {
      assert.deepEqual(await post(small, down), NO_CONTENT);
    } finally {
      await down.close();
    }
    const { events } = await stored(workspaceId);
    assert.deepEqual(
      events.map((event) => event.eventName),
      ["linkedin.message_received"],
    );
  } finally {
    clock = base + 20 * WINDOW_MS + 1_000;
  }
});

test("a second user connecting an account connected in the workspace already gets 409 sender_account_in_use, never 500; the vendor's next delivery of the notify gets 204", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const cookie = signInAs(a.user.id).map(({ name, value }) => `${name}=${value}`);
  const headers = {
    cookie: cookie.join("; "),
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  const disclosure = { acknowledged: true, disclosureVersion: 2, personalAccount: true };
  const body = JSON.stringify({ timeZone: "Europe/Paris", ...disclosure });
  const connect = new URL(`/v1/workspaces/${workspaceId}/linkedin/accounts/connect`, api.url);
  const started = await fetch(connect, { method: "POST", headers, body });
  assert.equal(started.status, 200);
  const link = new URL(((await started.json()) as { url: string }).url);
  const visit = await fetch(new URL(`${link.pathname}${link.search}`, api.url), {
    redirect: "manual",
  });
  await visit.body?.cancel();
  const notify = notified.at(-1) as LinkedinWebhook;
  // The LinkedIn account the visit connected is another member's account of the workspace already.
  const { account: ref } = JSON.parse(String(notify.rawBody));
  const first = await createConnectedAccount(workspaceId, { providerAccountRef: ref });

  assert.deepEqual(await post(notify), { status: 409, body: { code: "sender_account_in_use" } });
  const accounts = await app.senderAccount.findMany({ where: { workspaceId } });
  const second = accounts.find((account) => account.id !== first.id);
  assert.deepEqual(
    [second?.status, second?.providerLinkRef, second?.providerAccountRefHash],
    ["disconnected", null, null],
  );
  const kept = accounts.find((account) => account.id === first.id);
  assert.equal(kept?.status, "connected");
  assert.deepEqual(await post(notify), NO_CONTENT);
  assert.deepEqual((await stored(workspaceId)).events, []);
});
