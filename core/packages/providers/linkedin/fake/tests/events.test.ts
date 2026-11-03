// The fake's event helpers (../../README.md "Events"): each changes the fake's state as its event
// says and returns the signed webhook. emitAccepted turns the pending invitation into a relation;
// emitMessage adds the message to the chat listRecentMessages reads, as refs and its time;
// emitAccountStatus changes the account's status, which the reads and getAccountStatus answer.
// forge() copies a webhook of any kind with a wrong signature. Under APP_ENV=test the fake signs
// with TEST_WEBHOOK_SECRET, so a webhook signed in one process verifies in another; under
// development, with a secret drawn at start, it does not. And the log check: a forged, two
// off-shape and a good message event leave no message text, member ref or chat ref in an error, a
// log line, the console or a metric label.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { type TestContext, test } from "node:test";
import { inspect, promisify } from "node:util";
import { collectLogs, createLogger, isAppError, recordedMetrics } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { type LinkedinWebhook, linkedinPort } from "../../port.ts";
import { TEST_WEBHOOK_SECRET } from "../constants.ts";
import { linkedinFake, linkedinFakeAdapter, SIGNATURE_HEADER } from "../index.ts";

const ACCOUNT = "fake-account-ada";
const MEMBER = "fake-member-bao";
const CHAT = "fake-chat-bao";

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
const refused = failsWith("linkedin_webhook_invalid", {
  method: "parseWebhook",
  reason: "signature",
});
const bodyOf = (webhook: LinkedinWebhook) =>
  JSON.parse(String(webhook.rawBody)) as Record<string, unknown>;

/** A body signed as the fake signs under APP_ENV=test, which test:contract sets. */
function signed(body: unknown): LinkedinWebhook {
  const rawBody = JSON.stringify(body);
  const digest = createHmac("sha256", TEST_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return { headers: { [SIGNATURE_HEADER]: `sha256=${digest}` }, rawBody };
}

/** What the test prints through the console, which nothing here should. */
function consoleOf(t: TestContext): unknown[] {
  const printed: unknown[] = [];
  for (const level of ["debug", "info", "log", "warn", "error"] as const) {
    t.mock.method(console, level, (...args: unknown[]) => void printed.push(args));
  }
  return printed;
}

test("emitAccepted turns the pending invitation into a relation, under a new eventKey each time; with none pending, a relation all the same", async () => {
  const linkedin = boundFake();
  const member = { providerAccountRef: ACCOUNT, memberRef: MEMBER };
  const { invitationRef } = await linkedin.sendInvite({ ...member, idempotencyKey: "step-key-1" });
  const before = Date.now();
  const accepted = await linkedin.parseWebhook(linkedinFake.emitAccepted(ACCOUNT, MEMBER));
  assert.ok(accepted.kind === "invite.accepted");
  assert.deepEqual([accepted.providerAccountRef, accepted.memberRef], [ACCOUNT, MEMBER]);
  const at = accepted.occurredAt?.getTime() ?? 0;
  assert.ok(at >= before && at <= Date.now(), "occurredAt, the acceptance's time");
  assert.deepEqual(await linkedin.getRelation(member), {
    connected: true,
    invitationPending: false,
  });
  const pending = await linkedin.listPendingInvites({ providerAccountRef: ACCOUNT });
  assert.deepEqual(pending, { invites: [], nextCursor: null });
  await assert.rejects(
    linkedin.withdrawInvite({ providerAccountRef: ACCOUNT, invitationRef }),
    failsWith("linkedin_not_found", { method: "withdrawInvite" }),
  );
  const stranger = { providerAccountRef: ACCOUNT, memberRef: "fake-member-chidi" };
  const byHand = await linkedin.parseWebhook(
    linkedinFake.emitAccepted(ACCOUNT, stranger.memberRef),
  );
  assert.ok(byHand.kind === "invite.accepted");
  assert.notEqual(byHand.eventKey, accepted.eventKey, "a new eventKey");
  assert.deepEqual(await linkedin.getRelation(stranger), {
    connected: true,
    invitationPending: false,
  });
});

test("emitMessage adds the message to the chat listRecentMessages reads, as refs and its time; only the event carries its text", async () => {
  const linkedin = boundFake();
  const since = new Date(Date.now() - 1000);
  const inboundText = "Hello Ada, thanks for connecting";
  // The member writes first, in a chat the fake has not seen: opened under the ref given.
  const inbound = await linkedin.parseWebhook(
    linkedinFake.emitMessage(ACCOUNT, { memberRef: MEMBER, chatRef: CHAT, text: inboundText }),
  );
  assert.ok(inbound.kind === "message.received");
  const { chatRef, fromAccount, senderMemberRef, attendeeMemberRefs, text } = inbound;
  assert.deepEqual(
    { chatRef, fromAccount, senderMemberRef, attendeeMemberRefs, text },
    {
      chatRef: CHAT,
      fromAccount: false,
      senderMemberRef: MEMBER,
      attendeeMemberRefs: [MEMBER],
      text: inboundText,
    },
  );
  assert.equal(inbound.eventKey, inbound.messageRef, "a message's id is its eventKey");
  // The account answers by hand, no chat given: the member's own, its own member id the sender.
  const outbound = await linkedin.parseWebhook(
    linkedinFake.emitMessage(ACCOUNT, { memberRef: MEMBER, text: "Hi Bao", fromAccount: true }),
  );
  assert.ok(outbound.kind === "message.received");
  const { memberRef: self } = await linkedin.getAccountStatus(ACCOUNT);
  assert.deepEqual(
    [outbound.chatRef, outbound.fromAccount, outbound.senderMemberRef, outbound.attendeeMemberRefs],
    [CHAT, true, self, [MEMBER]],
  );
  const read = { providerAccountRef: ACCOUNT, memberRef: MEMBER, since };
  assert.deepEqual((await linkedin.listRecentMessages(read)).messages, [
    { messageRef: inbound.messageRef, chatRef: CHAT, fromAccount: false, sentAt: inbound.sentAt },
    { messageRef: outbound.messageRef, chatRef: CHAT, fromAccount: true, sentAt: outbound.sentAt },
  ]);
  const kept = inspect(linkedinFake.state, { depth: Number.POSITIVE_INFINITY });
  assert.ok(!kept.includes(inboundText) && !kept.includes("Hi Bao"), "the fake keeps no text");
  assert.throws(
    () =>
      linkedinFake.emitMessage(ACCOUNT, { memberRef: "fake-member-chidi", chatRef: CHAT, text }),
    failsWith("linkedin_not_found", { helper: "emitMessage", reason: "a chat of another member" }),
  );
});

test("emitAccountStatus changes the account's state: reads refuse with the status as the reason, getAccountStatus answers error for a warning", async () => {
  const linkedin = boundFake();
  const read = () => linkedin.getRelation({ providerAccountRef: ACCOUNT, memberRef: MEMBER });
  const answers = [
    ["checkpoint", "error"],
    ["restricted", "error"],
    ["credentials_required", "credentials_required"],
    ["disconnected", "disconnected"],
  ] as const;
  for (const [status, answered] of answers) {
    const event = await linkedin.parseWebhook(linkedinFake.emitAccountStatus(ACCOUNT, status));
    assert.deepEqual(event, { kind: "account.status", providerAccountRef: ACCOUNT, status });
    assert.equal((await linkedin.getAccountStatus(ACCOUNT)).status, answered, status);
    await assert.rejects(read(), failsWith("linkedin_account_disconnected", { reason: status }));
  }
  linkedinFake.emitAccountStatus(ACCOUNT, "connected");
  assert.equal((await linkedin.getAccountStatus(ACCOUNT)).status, "connected");
  assert.deepEqual(await read(), { connected: false, invitationPending: false });
  linkedinFake.emitAccountStatus("fake-account-new", "restricted");
  assert.equal((await linkedin.getAccountStatus("fake-account-new")).status, "error", "created");
});

test("forge copies a webhook of any kind with a wrong signature, keeping the body and the other headers, and leaves the webhook as it was", async () => {
  const linkedin = boundFake();
  const bytes = {
    headers: { "X-LinkedIn-Fake-Signature": "sha256=0", "x-request-id": "request-1" },
    rawBody: new TextEncoder().encode('{"type":"account.disconnected","account":"a"}'),
  };
  const webhooks = [
    linkedinFake.emitWebhook("account.disconnected", ACCOUNT),
    linkedinFake.emitAccountStatus(ACCOUNT, "connected"),
    linkedinFake.emitAccepted(ACCOUNT, MEMBER),
    linkedinFake.emitMessage(ACCOUNT, { memberRef: MEMBER, text: "Hello" }),
    signed({ type: "message.reaction", account: ACCOUNT }),
    bytes,
  ];
  for (const webhook of webhooks) {
    const before = structuredClone(webhook);
    const copy = linkedinFake.forge(webhook);
    assert.deepEqual(webhook, before, "the webhook as it was");
    assert.notEqual(copy.headers, webhook.headers);
    assert.deepEqual(copy.rawBody, webhook.rawBody);
    const named = (name: string) => name.toLowerCase() === SIGNATURE_HEADER;
    const signatures = Object.entries(copy.headers).filter(([name]) => named(name));
    assert.equal(signatures.length, 1, "one signature");
    assert.match(String(signatures[0]?.[1]), /^sha256=[0-9a-f]{64}$/);
    const others = (headers: LinkedinWebhook["headers"]) =>
      Object.entries(headers).filter(([name]) => !named(name));
    assert.deepEqual(others(copy.headers), others(webhook.headers), "the other headers");
    await assert.rejects(linkedin.parseWebhook(copy), refused);
  }
  for (const webhook of webhooks.slice(0, -1)) await linkedin.parseWebhook(webhook);
});

test("under APP_ENV=test a webhook the fake signed in one process verifies in another; under development, with a secret drawn at start, it does not", async () => {
  const linkedin = boundFake();
  const fake = JSON.stringify(import.meta.resolve("../index.ts"));
  const script = [
    `const { linkedinFake } = await import(${fake});`,
    'const account = "fake-account-elsewhere";',
    "console.log(JSON.stringify([",
    '  linkedinFake.emitWebhook("account.connected", account),',
    '  linkedinFake.emitMessage(account, { memberRef: "fake-member-elsewhere", text: "Hello" }),',
    "]));",
  ].join("\n");
  const signedIn = (APP_ENV: string) =>
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, APP_ENV },
    }).then(
      ({ stdout }) => JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as LinkedinWebhook[],
    );
  const [inTest, inDevelopment] = await Promise.all([signedIn("test"), signedIn("development")]);
  const kinds: string[] = [];
  for (const webhook of inTest) kinds.push((await linkedin.parseWebhook(webhook)).kind);
  assert.deepEqual(kinds, ["account.connected", "message.received"]);
  for (const webhook of inDevelopment)
    await assert.rejects(linkedin.parseWebhook(webhook), refused);
});

test("no message text, member ref or chat ref in an error's details, a log line, the console or a metric label: a forged, two off-shape and a good message event", async (t) => {
  const linkedin = boundFake();
  const logs = collectLogs();
  const logger = createLogger({ destination: logs.destination });
  const printed = consoleOf(t);
  const text = "A synthetic reply that names nobody";
  const good = linkedinFake.emitMessage(ACCOUNT, { memberRef: MEMBER, chatRef: CHAT, text });
  const event = await linkedin.parseWebhook(good);
  assert.ok(event.kind === "message.received");
  const body = bodyOf(good);
  const requests = [
    ["linkedin_webhook_invalid", linkedinFake.forge(good)],
    // Off the port's words: a text over 20,000 characters, which the boundary refuses.
    ["linkedin_output_invalid", signed({ ...body, text: text.repeat(1000) })],
    // Off the fake's format: attendees that are not a list.
    ["linkedin_webhook_invalid", signed({ ...body, attendees: MEMBER })],
  ] as const;
  const errors: unknown[] = [];
  for (const [code, request] of requests) {
    const error = await linkedin.parseWebhook(request).then(
      () => undefined,
      (e: unknown) => e,
    );
    failsWith(code)(error);
    errors.push(error);
    // As the host logs a refusal: the error, its code and details.
    logger.error({ err: error }, "linkedin webhook refused");
  }
  const calls = recordedMetrics().get("providers.calls") ?? [];
  const outcomes = calls.filter((labels) => labels.method === "parseWebhook");
  assert.deepEqual([...new Set(outcomes.map((labels) => labels.outcome))].toSorted(), [
    "linkedin_output_invalid",
    "linkedin_webhook_invalid",
    "ok",
  ]);
  const seen = inspect([errors, logs.raw, printed, calls], {
    depth: Number.POSITIVE_INFINITY,
    showHidden: true,
  });
  const personal = [text, MEMBER, CHAT, event.messageRef];
  assert.deepEqual(
    personal.filter((value) => seen.includes(value)),
    [],
  );
  assert.equal(logs.lines().length, errors.length, "the refusals were logged");
});
