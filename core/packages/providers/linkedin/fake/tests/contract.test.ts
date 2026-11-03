// The fake's contract suite (README.md "The contract suite"). Its world seeds a post of ninety
// engagers and a profile, connects through connectOnVisit() mounted on a node:http server of the
// test's own (fetch, to 127.0.0.1 only), signs webhooks with emitWebhook, gives a member to invite,
// a relation to message (seedRelation) and a disconnected account, and an event of every kind from
// the event helpers (an unknown type signed with TEST_WEBHOOK_SECRET, as the fake signs under
// APP_ENV=test), forged with forge(). Then the fake's own: failNext's retryAfterSec, every code and a
// reason, recordedCalls, answerNext, the send side's refusals and acceptInvite, create() and the
// route under APP_ENV=test only, every account's memberRef, and an extra key on each kind.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { promisify } from "node:util";
import { isAppError } from "@whytide/platform";
import { bindPort, type PortErrorCode } from "../../../_pattern/index.ts";
import { contractSuite } from "../../../testing/index.ts";
import { type LinkedinWorld, linkedinCases, RETURN_URLS } from "../../contract.ts";
import {
  type Engager,
  LINKEDIN_WEBHOOK_KINDS,
  type LinkedinWebhook,
  type LinkedinWebhookEvent,
  linkedinPort,
} from "../../port.ts";
import { TEST_WEBHOOK_SECRET } from "../constants.ts";
import { linkedinFake, linkedinFakeAdapter, SIGNATURE_HEADER } from "../index.ts";

const POST = "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/";
const ADA = {
  providerMemberRef: "fake-member-ada",
  profileUrl: "https://www.linkedin.com/in/ada-example",
  firstName: "Ada",
  lastName: "Example",
  headline: "Head of Growth at Example",
  title: "Head of Growth",
  companyName: "Example Ltd",
  companyUrl: "https://www.linkedin.com/company/example",
  locationText: "London, United Kingdom",
  industry: "Software Development",
};
const engager = (i: number): Engager => ({
  providerMemberRef: `fake-member-${i}`,
  profileUrl: `https://www.linkedin.com/in/member-${i}`,
  name: `Member ${i}`,
  headline: "Founder at Example",
  reaction: i % 3 === 0 ? "comment" : "like",
  ...(i % 3 === 0 ? { commentText: "Useful, thanks" } : {}),
  engagedAt: new Date(Date.UTC(2026, 9, 1, 8, i)),
});
const EVENTS_ACCOUNT = "fake-account-events";
const EVENTS_MEMBER = "fake-member-events";
const EVENTS_CHAT = "fake-chat-events";
const TEXT = "Thanks for connecting: happy to talk next week";

/** The fake's body of a webhook, in its own format (README.md "Events"). */
const bodyOf = (webhook: LinkedinWebhook) =>
  JSON.parse(String(webhook.rawBody)) as Record<string, string>;

/** A body of a type the fake does not send, signed as the fake signs under APP_ENV=test. */
function unknownType(): LinkedinWebhook {
  const rawBody = JSON.stringify({ type: "message.reaction", account: EVENTS_ACCOUNT });
  const digest = createHmac("sha256", TEST_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return { headers: { [SIGNATURE_HEADER]: `sha256=${digest}` }, rawBody };
}

/** A signed event of the kind from the fake's helpers, and what parseWebhook gives for it. */
function fakeEvent(kind: LinkedinWebhookEvent["kind"]): {
  webhook: LinkedinWebhook;
  expected: LinkedinWebhookEvent;
} {
  const providerAccountRef = EVENTS_ACCOUNT;
  const memberRef = EVENTS_MEMBER;
  switch (kind) {
    case "account.connected":
    case "account.disconnected":
    case "account.credentials_required":
      return {
        webhook: linkedinFake.emitWebhook(kind, providerAccountRef),
        expected: { kind, providerAccountRef },
      };
    case "account.status":
      return {
        webhook: linkedinFake.emitAccountStatus(providerAccountRef, "checkpoint"),
        expected: { kind, providerAccountRef, status: "checkpoint" },
      };
    case "invite.accepted": {
      const webhook = linkedinFake.emitAccepted(providerAccountRef, memberRef);
      const { id: eventKey, at } = bodyOf(webhook);
      const occurredAt = new Date(String(at));
      return {
        webhook,
        expected: { kind, providerAccountRef, eventKey: String(eventKey), memberRef, occurredAt },
      };
    }
    case "message.received": {
      const message = { memberRef, chatRef: EVENTS_CHAT, text: TEXT };
      const webhook = linkedinFake.emitMessage(providerAccountRef, message);
      const { id, sent_at: sentAt } = bodyOf(webhook);
      return {
        webhook,
        expected: {
          kind,
          providerAccountRef,
          eventKey: String(id),
          chatRef: EVENTS_CHAT,
          messageRef: String(id),
          senderMemberRef: memberRef,
          fromAccount: false,
          attendeeMemberRefs: [memberRef],
          text: TEXT,
          sentAt: new Date(String(sentAt)),
        },
      };
    }
    case "ignored":
      return { webhook: unknownType(), expected: { kind } };
  }
}

const world: LinkedinWorld = {
  connect: async (link, t) => {
    const delivered: LinkedinWebhook[] = [];
    const handler = linkedinFake.connectOnVisit(async (webhook) => delivered.push(webhook));
    const server = createServer((req, res) => handler(req, res, () => res.writeHead(404).end()));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const { port } = server.address() as AddressInfo;
    const { pathname, search } = new URL(link.url);
    const visit = () =>
      fetch(`http://127.0.0.1:${port}${pathname}${search}`, { redirect: "manual" });
    const response = await visit();
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), RETURN_URLS.successUrl);
    assert.equal((await visit()).status, 404, "a link works once");
    assert.equal(delivered.length, 1);
    return delivered[0] as LinkedinWebhook;
  },
  post: async () => {
    linkedinFake.seedPost(
      POST,
      Array.from({ length: 90 }, (_, i) => engager(i)),
    );
    return { postUrl: POST, engagers: 90 };
  },
  profile: async () => {
    linkedinFake.seedProfile(ADA);
    return { profileUrl: ADA.profileUrl, expected: ADA };
  },
  webhook: async ({ kind, providerAccountRef }, { forged = false } = {}) => {
    const webhook = linkedinFake.emitWebhook(kind, providerAccountRef);
    return forged ? linkedinFake.forge(webhook) : webhook;
  },
  event: async (kind) => {
    const { webhook, expected } = fakeEvent(kind);
    return { webhook, forged: linkedinFake.forge(webhook), expected };
  },
  rateLimitNext: () => linkedinFake.failNext("linkedin_rate_limited"),
  recipient: async (providerAccountRef, { relation = false } = {}) => {
    const memberRef = relation ? "fake-member-relation" : "fake-member-stranger";
    if (relation) linkedinFake.seedRelation(providerAccountRef, memberRef);
    return memberRef;
  },
  disconnected: async () => {
    linkedinFake.emitWebhook("account.disconnected", "fake-account-disconnected");
    return "fake-account-disconnected";
  },
};

contractSuite(linkedinPort, linkedinFakeAdapter, linkedinCases(world));

const ACCOUNT = "fake-account-ada";
const MEMBER = "fake-member-bao";
/** The fake bound as the registry binds it, reset, with ACCOUNT connected. */
function boundFake() {
  const linkedin = bindPort(linkedinPort, linkedinFakeAdapter.create(), { adapter: "fake" });
  linkedinFake.reset();
  linkedinFake.emitWebhook("account.connected", ACCOUNT);
  return linkedin;
}
const failsWith = (code: string, details?: Record<string, unknown>) => (error: unknown) => {
  assert.ok(isAppError(error) && error.code === code, `${code}, not ${String(error)}`);
  if (details) assert.deepEqual(error.details, details);
  return true;
};
/** Runs a module script in a child process under APP_ENV, printing its stdout's last line. */
const runAs = (APP_ENV: string, script: string) =>
  promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, APP_ENV },
  }).then(({ stdout }) => `${APP_ENV} ${stdout.trim()}`);

test("failNext('linkedin_rate_limited') carries retryAfterSec; recordedCalls holds every call with its input", async () => {
  const linkedin = bindPort(linkedinPort, linkedinFakeAdapter.create(), { adapter: "fake" });
  linkedinFake.reset();
  const ref = "fake-account-ada";
  const webhook = linkedinFake.emitWebhook("account.connected", ref);
  linkedinFake.seedPost(POST, [engager(1)]);
  linkedinFake.seedProfile(ADA);
  const retryAfter = (error: unknown) => isAppError(error) && error.details?.retryAfterSec;
  linkedinFake.failNext("linkedin_rate_limited");
  await assert.rejects(linkedin.getAccountStatus(ref), (error) => retryAfter(error) === 60);
  linkedinFake.failNext("linkedin_rate_limited", { retryAfterSec: 5 });
  await assert.rejects(linkedin.getAccountStatus(ref), (error) => retryAfter(error) === 5);
  const link = { successUrl: RETURN_URLS.successUrl, failureUrl: RETURN_URLS.failureUrl };
  await linkedin.createHostedAuthLink({ ...link, expiresInMin: 5 });
  await linkedin.listPostEngagers({ providerAccountRef: ref, postUrl: POST, limit: 10 });
  await linkedin.getProfile({ providerAccountRef: ref, profileUrl: ADA.profileUrl });
  await linkedin.parseWebhook(webhook);
  assert.deepEqual(linkedinFake.recordedCalls, [
    { method: "getAccountStatus", input: ref },
    { method: "getAccountStatus", input: ref },
    { method: "createHostedAuthLink", input: { ...link, expiresInMin: 5 } },
    { method: "listPostEngagers", input: { providerAccountRef: ref, postUrl: POST, limit: 10 } },
    { method: "getProfile", input: { providerAccountRef: ref, profileUrl: ADA.profileUrl } },
    { method: "parseWebhook", input: webhook },
  ]);
});

test("failNext gives each declared code typed, linkedin_limit_reached and linkedin_send_refused included; linkedin_account_disconnected carries the reason given", async () => {
  const linkedin = boundFake();
  const statuses = {
    linkedin_rate_limited: 429,
    linkedin_account_disconnected: 409,
    linkedin_not_found: 404,
    linkedin_webhook_invalid: 401,
    linkedin_provider_error: 502,
    linkedin_limit_reached: 429,
    linkedin_send_refused: 422,
  };
  assert.deepEqual(Object.keys(linkedinPort.errors), Object.keys(statuses));
  const send = { providerAccountRef: ACCOUNT, memberRef: MEMBER, idempotencyKey: "step-key-1" };
  for (const [code, status] of Object.entries(statuses)) {
    linkedinFake.failNext(code as PortErrorCode<typeof linkedinPort>);
    await assert.rejects(linkedin.sendInvite(send), (error: unknown) => {
      failsWith(code)(error);
      assert.equal((error as { status?: number }).status, status, code);
      return true;
    });
  }
  linkedinFake.failNext("linkedin_account_disconnected", { reason: "checkpoint" });
  await assert.rejects(
    linkedin.sendInvite(send),
    failsWith("linkedin_account_disconnected", { reason: "checkpoint" }),
  );
  assert.equal(linkedinFake.recordedCalls.length, 8, "every failed call recorded");
});

test("answerNext: a sendInvite answer with an extra key fails linkedin_output_invalid; a plain Error linkedin_error_unmapped", async () => {
  const linkedin = boundFake();
  const send = { providerAccountRef: ACCOUNT, memberRef: MEMBER, idempotencyKey: "step-key-1" };
  const sentAt = new Date();
  linkedinFake.answerNext("sendInvite", { invitationRef: "fake-invitation-1", sentAt, extra: 1 });
  await assert.rejects(
    linkedin.sendInvite(send),
    failsWith("linkedin_output_invalid", {
      method: "sendInvite",
      issues: ['.: Unrecognized key: "extra"'],
    }),
  );
  linkedinFake.answerNext("sendInvite", new Error("socket hang up"));
  await assert.rejects(
    linkedin.sendInvite(send),
    failsWith("linkedin_error_unmapped", { method: "sendInvite", code: "Error" }),
  );
  // Answered calls bypass the fake: nothing is pending, the next call sends.
  assert.deepEqual(await linkedin.listPendingInvites({ providerAccountRef: ACCOUNT }), {
    invites: [],
    nextCursor: null,
  });
  assert.equal(
    (await linkedin.sendInvite(send)).invitationRef.startsWith("fake-invitation-"),
    true,
  );
});

test("the fake's sends: an invitation to a relation or a pending member and a message to a non-relation are refused; acceptInvite makes a relation; unknown refs are linkedin_not_found", async () => {
  const linkedin = boundFake();
  const member = { providerAccountRef: ACCOUNT, memberRef: MEMBER };
  const invite = { ...member, note: "Met at the meetup", idempotencyKey: "step-key-1" };
  const message = { ...member, text: "Thanks for connecting", idempotencyKey: "step-key-2" };
  await assert.rejects(
    linkedin.sendMessage(message),
    failsWith("linkedin_send_refused", { method: "sendMessage", reason: "not_connected" }),
  );
  const { invitationRef } = await linkedin.sendInvite(invite);
  await assert.rejects(
    linkedin.sendInvite(invite),
    failsWith("linkedin_send_refused", { method: "sendInvite", reason: "already_invited" }),
  );
  await assert.rejects(
    linkedin.withdrawInvite({ providerAccountRef: ACCOUNT, invitationRef: `${invitationRef}-x` }),
    failsWith("linkedin_not_found", { method: "withdrawInvite" }),
  );
  linkedinFake.acceptInvite(ACCOUNT, MEMBER);
  assert.deepEqual(await linkedin.getRelation(member), {
    connected: true,
    invitationPending: false,
  });
  await assert.rejects(
    linkedin.sendInvite(invite),
    failsWith("linkedin_send_refused", { method: "sendInvite", reason: "already_connected" }),
  );
  await assert.rejects(
    linkedin.withdrawInvite({ providerAccountRef: ACCOUNT, invitationRef }),
    failsWith("linkedin_not_found", { method: "withdrawInvite" }),
    "an accepted invitation is no longer pending",
  );
  assert.throws(() => linkedinFake.acceptInvite(ACCOUNT, MEMBER), failsWith("linkedin_not_found"));
  // The member's chat is found again, or the chat given, which must be the member's.
  const since = new Date(Date.now() - 1000);
  const first = await linkedin.sendMessage(message);
  const second = await linkedin.sendMessage({ ...message, chatRef: first.chatRef });
  assert.equal(second.chatRef, first.chatRef);
  await assert.rejects(
    linkedin.sendMessage({ ...message, chatRef: "fake-chat-unknown" }),
    failsWith("linkedin_not_found", { method: "sendMessage" }),
  );
  const read = { ...member, since };
  assert.equal((await linkedin.listRecentMessages(read)).messages.length, 2);
  const later = { ...member, since: new Date(Date.now() + 60_000) };
  assert.deepEqual(await linkedin.listRecentMessages(later), { messages: [] });
  const stranger = { providerAccountRef: ACCOUNT, memberRef: "fake-member-chidi", since };
  assert.deepEqual(await linkedin.listRecentMessages(stranger), { messages: [] });
  // The account: unknown, then needing its credentials, with the reason.
  const unknown = { ...message, providerAccountRef: "fake-account-unknown" };
  await assert.rejects(linkedin.sendMessage(unknown), failsWith("linkedin_not_found"));
  linkedinFake.emitWebhook("account.credentials_required", ACCOUNT);
  await assert.rejects(
    linkedin.sendMessage(message),
    failsWith("linkedin_account_disconnected", { reason: "credentials_required" }),
  );
});

test("create() refuses APP_ENV=production with adapter_invalid, through the registry too", async () => {
  const fake = JSON.stringify(import.meta.resolve("../index.ts"));
  const registry = JSON.stringify(import.meta.resolve("../../../registry.ts"));
  const port = JSON.stringify(import.meta.resolve("../../port.ts"));
  const script = [
    `const { linkedinFakeAdapter } = await import(${fake});`,
    `const { getAdapter } = await import(${registry});`,
    `const { linkedinPort } = await import(${port});`,
    "const outcome = (run) => run().then(() => 'created', (error) => error.code);",
    "const direct = await outcome(async () => linkedinFakeAdapter.create());",
    "const registered = await outcome(() => getAdapter(linkedinPort, 'fake'));",
    "console.log(`${direct} ${registered}`);",
  ].join("\n");
  assert.deepEqual(await Promise.all(["test", "production"].map((env) => runAs(env, script))), [
    "test created created",
    "production adapter_invalid adapter_invalid",
  ]);
});

test("the connect route is served under APP_ENV=test only", async () => {
  const fake = JSON.stringify(import.meta.resolve("../index.ts"));
  const script = [
    `const { linkedinFake } = await import(${fake});`,
    "const handler = linkedinFake.connectOnVisit();",
    "const { url } = await linkedinFake.createHostedAuthLink({",
    '  successUrl: "https://app.whytide.test/ok", failureUrl: "https://app.whytide.test/ko", expiresInMin: 5 });',
    "let answer = 404;",
    "const res = { headersSent: false, writeHead: (status) => ((answer = status), { end() {} }) };",
    'handler({ method: "GET", url: new URL(url).pathname + new URL(url).search }, res, () => {});',
    "await new Promise((resolve) => setTimeout(resolve, 50));",
    "console.log(answer);",
  ].join("\n");
  const run = (APP_ENV: string) => runAs(APP_ENV, script);
  assert.deepEqual(await Promise.all(["test", "development", "production"].map(run)), [
    "test 303",
    "development 404",
    "production 404",
  ]);
});

test("getAccountStatus answers a memberRef for every account, the same on every call, one per account; the schema takes null", async () => {
  const linkedin = boundFake();
  linkedinFake.emitAccountStatus("fake-account-bao", "checkpoint");
  linkedinFake.emitWebhook("account.disconnected", "fake-account-chidi");
  const memberRefs = new Set<string>();
  for (const account of [ACCOUNT, "fake-account-bao", "fake-account-chidi"]) {
    const { memberRef } = await linkedin.getAccountStatus(account);
    assert.ok(memberRef, `${account}: a memberRef`);
    assert.equal((await linkedin.getAccountStatus(account)).memberRef, memberRef, account);
    memberRefs.add(memberRef);
  }
  assert.equal(memberRefs.size, 3, "each account its own");
  // An adapter whose vendor gives none: null passes, a missing key does not.
  const status = { status: "connected", checkedAt: new Date() };
  linkedinFake.answerNext("getAccountStatus", { ...status, memberRef: null });
  assert.equal((await linkedin.getAccountStatus(ACCOUNT)).memberRef, null);
  linkedinFake.answerNext("getAccountStatus", status);
  await assert.rejects(linkedin.getAccountStatus(ACCOUNT), (error: unknown) => {
    failsWith("linkedin_output_invalid")(error);
    assert.equal((error as { details?: { method?: string } }).details?.method, "getAccountStatus");
    return true;
  });
});

test("each kind parses from the fake to its exact shape; one key more is linkedin_output_invalid", async () => {
  const linkedin = boundFake();
  for (const kind of LINKEDIN_WEBHOOK_KINDS) {
    const { webhook, expected } = fakeEvent(kind);
    assert.deepEqual(await linkedin.parseWebhook(webhook), expected, kind);
    linkedinFake.answerNext("parseWebhook", { ...expected, extra: 1 });
    await assert.rejects(
      linkedin.parseWebhook(webhook),
      failsWith("linkedin_output_invalid", {
        method: "parseWebhook",
        issues: ['.: Unrecognized key: "extra"'],
      }),
      kind,
    );
  }
});
