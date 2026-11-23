// The fake's contract suite (../../README.md "The contract suite") on fakeWorld, then the fake's
// own: consentNext's address and scopes, exchangeCode's refusals, the refresh token's rotation, a
// thread played as the platform's, listNewMessages' pages, answers off the port's words, a foreign
// code refused, and the log check: no token, raw message, address, subject or text in an error, a
// log line, the console or a metric label, and no logger or span in the port's code.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { collectLogs, createLogger, isAppError, recordedMetrics } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { contractSuite } from "../../../testing/index.ts";
import {
  connectByConsent,
  consentOf,
  mailboxCases,
  REDIRECT_URI,
  rawMessage,
} from "../../contract.ts";
import { codeChallengeFor, newCodeVerifier } from "../../pkce.ts";
import { type MailboxScope, mailboxPort, messageIdFor } from "../../port.ts";
import { FAKE_ADDRESS } from "../constants.ts";
import { mailboxFake, mailboxFakeAdapter } from "../index.ts";
import { fakeWorld } from "./world.ts";

contractSuite(mailboxPort, mailboxFakeAdapter, mailboxCases(fakeWorld));

const mailbox = bindPort(mailboxPort, mailboxFake, { adapter: "fake" });
const LEAD = "lead@example.test";
const NO_MATCH = { threadRefs: [], messageIds: [] };
const idFor = (idempotencyKey: string) => messageIdFor({ idempotencyKey, domain: "example.test" });
const fails = (code: string) => (error: unknown) => {
  assert.ok(isAppError(error) && error.code === code, `expected ${code}: ${error}`);
  return true;
};

test("consentNext drives the grant: the address in lower case or null, the scopes in the port's words and order", async () => {
  mailboxFake.reset();
  const cases: [Parameters<typeof mailboxFake.consentNext>[0], string | null, MailboxScope[]][] = [
    [{}, FAKE_ADDRESS, ["send", "read"]],
    [{ address: "Ada.Member@Example.TEST" }, "ada.member@example.test", ["send", "read"]],
    [{ address: null, scopes: ["read", "send"] }, null, ["send", "read"]],
    [{ scopes: ["read"] }, FAKE_ADDRESS, ["read"]],
    [{ scopes: [] }, FAKE_ADDRESS, []],
  ];
  for (const [consent, address, scopes] of cases) {
    mailboxFake.consentNext(consent);
    const granted = await consentOf(mailbox);
    assert.deepEqual([granted.address, granted.scopes], [address, scopes]);
  }
  mailboxFake.consentNext({ scopes: ["read"] });
  const { address, accessToken } = await connectByConsent(mailbox);
  const messageId = idFor("read-only");
  const raw = rawMessage({ from: address, to: LEAD, messageId });
  const send = { accessToken, raw, messageId, idempotencyKey: "read-only" };
  await assert.rejects(mailbox.sendMessage(send), fails("mailbox_scope_missing"));
});

test("exchangeCode refuses a code it did not give, a used one, another redirectUri and another verifier: mailbox_input_invalid", async () => {
  mailboxFake.reset();
  const pending = async () => {
    const codeVerifier = newCodeVerifier();
    const codeChallenge = codeChallengeFor(codeVerifier);
    const auth = { redirectUri: REDIRECT_URI, state: "state-1", codeChallenge };
    const code = new URL((await mailbox.createAuthUrl(auth)).url).searchParams.get("code") ?? "";
    return { code, redirectUri: REDIRECT_URI, codeVerifier };
  };
  const used = await pending();
  await mailbox.exchangeCode(used);
  const refused = [
    { ...(await pending()), code: "fake-code-never-given" },
    used,
    { ...(await pending()), redirectUri: "https://elsewhere.example/callback" },
    { ...(await pending()), codeVerifier: newCodeVerifier() },
  ];
  for (const exchange of refused)
    await assert.rejects(mailbox.exchangeCode(exchange), fails("mailbox_input_invalid"));
});

test("refreshAccess rotates the refresh token: the new one refreshes, the old one is mailbox_token_revoked, the old access token still reads", async () => {
  mailboxFake.reset();
  const { address, accessToken, refreshToken } = await connectByConsent(mailbox);
  const fresh = await mailbox.refreshAccess({ refreshToken });
  assert.ok(fresh.refreshToken !== undefined && fresh.refreshToken !== refreshToken);
  await assert.rejects(mailbox.refreshAccess({ refreshToken }), fails("mailbox_token_revoked"));
  await mailbox.refreshAccess({ refreshToken: fresh.refreshToken });
  const read = { accessToken, address, cursor: null, match: NO_MATCH, limit: 1 };
  assert.deepEqual((await mailbox.listNewMessages(read)).events, []);
});

test("a thread played as the platform's reads; one typed by hand under the mail program's Message-ID is mailbox_not_found; a send joins a known thread, and an unknown one is mailbox_not_found", async () => {
  mailboxFake.reset();
  const { address, accessToken } = await connectByConsent(mailbox);
  const asPlatform = mailboxFake.playSent({ messageId: idFor("played") });
  const byHand = mailboxFake.playSent();
  const read = (threadRef: string) =>
    mailbox.readThread({ accessToken, address, threadRef, limit: 5 });
  assert.deepEqual(
    (await read(asPlatform.threadRef)).events.map(({ kind }) => kind),
    ["sent"],
  );
  await assert.rejects(read(byHand.threadRef), fails("mailbox_not_found"));
  const messageId = idFor("joins");
  const raw = rawMessage({ from: address, to: LEAD, messageId });
  const send = (threadRef: string) =>
    mailbox.sendMessage({ accessToken, raw, messageId, threadRef, idempotencyKey: "joins" });
  assert.equal((await send(asPlatform.threadRef)).threadRef, asPlatform.threadRef);
  await assert.rejects(send("fake-thread-unknown"), fails("mailbox_not_found"));
});

test("listNewMessages reads at most limit messages, outside the match included: more, and the next page resumes after the last one read", async () => {
  mailboxFake.reset();
  const { address, accessToken } = await connectByConsent(mailbox);
  const messageId = idFor("pages");
  const raw = rawMessage({ from: address, to: LEAD, messageId });
  const sent = await mailbox.sendMessage({ accessToken, raw, messageId, idempotencyKey: "pages" });
  const match = { threadRefs: [sent.threadRef ?? ""], messageIds: [messageId] };
  const list = (cursor: string | null) =>
    mailbox.listNewMessages({ accessToken, address, cursor, match, limit: 2 });
  let { cursor } = await list(null);
  const replies = [0, 1, 2].map(() => {
    const reply = mailboxFake.playReply({ inReplyTo: messageId });
    mailboxFake.playPersonal();
    return reply.messageRef;
  });
  const pages: [string[], boolean][] = [];
  for (let page = 0; page < 4; page++) {
    const answer = await list(cursor);
    pages.push([answer.events.map((event) => event.messageRef), answer.more]);
    cursor = answer.cursor;
  }
  const [r0, r1, r2] = replies;
  assert.deepEqual(pages, [
    [[r0], true],
    [[r1], true],
    [[r2], false],
    [[], false],
  ]);
});

test("an answer off the port's words is mailbox_output_invalid, a vendor error mailbox_error_unmapped; a code the port does not declare is refused", async () => {
  mailboxFake.reset();
  const { accessToken } = await connectByConsent(mailbox);
  const messageId = idFor("answers");
  const event = {
    messageRef: "m-1",
    threadRef: "t-1",
    at: new Date(),
    originalMessageId: messageId,
  };
  const answers: [string, unknown][] = [
    [
      "findSent",
      { found: true, messageRef: "m-1", threadRef: "t-1", sentAt: new Date(), snippet: "x" },
    ],
    [
      "listNewMessages",
      {
        events: [{ kind: "bounce", ...event, permanent: false, status: "5.1.1" }],
        cursor: "c",
        more: false,
      },
    ],
    [
      "listNewMessages",
      {
        events: [{ kind: "complaint", ...event, feedbackType: "abuse", recipient: LEAD }],
        cursor: "c",
        more: false,
      },
    ],
  ];
  const read = { accessToken, address: LEAD, cursor: "c", match: NO_MATCH, limit: 1 };
  for (const [method, answer] of answers) {
    mailboxFake.answerNext(method as "findSent", answer);
    const call =
      method === "findSent"
        ? mailbox.findSent({ accessToken, messageId })
        : mailbox.listNewMessages(read);
    await assert.rejects(call, fails("mailbox_output_invalid"));
  }
  mailboxFake.answerNext("findSent", new Error("a vendor's words"));
  await assert.rejects(
    mailbox.findSent({ accessToken, messageId }),
    fails("mailbox_error_unmapped"),
  );
  for (const control of [mailboxFake.failNext, mailboxFake.failAfterSendNext])
    assert.throws(() => control("linkedin_rate_limited" as never), fails("adapter_invalid"));
});

test("no token, raw message, address, subject or text in an error, a log line, the console or a metric label; the port's code has no logger and opens no span", async (t) => {
  mailboxFake.reset();
  const logs = collectLogs();
  const logger = createLogger({ destination: logs.destination });
  const printed: unknown[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    t.mock.method(console, level, (...args: unknown[]) => void printed.push(args));
  const { address, accessToken, refreshToken } = await connectByConsent(mailbox);
  const [subject, text, replyText] = [
    "A synthetic subject",
    "A synthetic text",
    "A synthetic reply",
  ];
  const messageId = idFor("logs");
  const raw = rawMessage({ from: address, to: LEAD, messageId, subject, text });
  const sent = await mailbox.sendMessage({ accessToken, raw, messageId, idempotencyKey: "logs" });
  const match = { threadRefs: [sent.threadRef ?? ""], messageIds: [messageId] };
  const list = { accessToken, address, match, limit: 10 };
  const { cursor } = await mailbox.listNewMessages({ ...list, cursor: null });
  mailboxFake.playReply({ inReplyTo: messageId, text: replyText });
  const personal = mailboxFake.playPersonal({ subject, text });
  assert.equal((await mailbox.listNewMessages({ ...list, cursor })).events.length, 1);
  const refusals = [
    () =>
      mailbox.sendMessage({
        accessToken,
        raw: `${raw}\nBcc: ${LEAD}`,
        messageId,
        idempotencyKey: "logs",
      }),
    () =>
      mailbox.sendMessage({
        accessToken,
        raw: raw.replace(LEAD, `${LEAD}, ${address}`),
        messageId,
        idempotencyKey: "logs",
      }),
    () => mailbox.readThread({ accessToken, address, threadRef: personal.threadRef, limit: 1 }),
    () => mailbox.refreshAccess({ refreshToken: `${refreshToken}-unknown` }),
    () => mailbox.findSent({ accessToken: `${accessToken}-unknown`, messageId }),
  ];
  const errors: unknown[] = [];
  for (const refusal of refusals) {
    const error = await refusal().then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(isAppError(error), String(error));
    errors.push(error);
    logger.error({ err: error }, "mailbox call refused"); // as a host logs a refusal
  }
  const labels = (recordedMetrics().get("providers.calls") ?? []).filter(
    (l) => l.port === "mailbox",
  );
  const seen = inspect([errors, logs.raw, printed, labels], { depth: Infinity, showHidden: true });
  const secret = [accessToken, refreshToken, address, LEAD, subject, text, replyText, raw];
  assert.deepEqual(
    secret.filter((value) => seen.includes(value)),
    [],
  );
  assert.equal(logs.lines().length, errors.length, "the refusals were logged");
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const sources = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (file) => file.endsWith(".ts") && !file.split("/").includes("tests"),
  );
  assert.ok(sources.includes("port.ts") && sources.includes("fake/index.ts"), sources.join());
  for (const file of sources) {
    const source = readFileSync(`${root}/${file}`, "utf8");
    assert.doesNotMatch(source, /console\.|createLogger|withSpan|opentelemetry|\blogger\b/, file);
  }
});
