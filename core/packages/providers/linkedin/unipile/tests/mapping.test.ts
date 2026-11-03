// The Unipile adapter's mapping and error tests (README.md "Tests"), offline: unipileLinkedin()
// against a node:http server of the test's own on 127.0.0.1, serving the synthetic fixtures of
// fixtures/ (shaped like Unipile's documentation, never recorded) and recording each request, so
// that the adapter's real request code runs. No vendor is called; the key and the secrets are made
// up for the run. The config checks and the log check run in child processes: the config is read
// when the adapter is imported, and a line can reach a process's stdout by more than one route.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { after, beforeEach, type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { collectLogs, createLogger, isAppError } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { linkedinCases } from "../../contract.ts";
import { LINKEDIN_WEBHOOK_KINDS, type LinkedinWebhook, linkedinPort } from "../../port.ts";
import { MAX_ANSWER_BYTES } from "../constants.ts";
import { signedCursors } from "../cursor.ts";
import { SECRET_HEADER, unipileLinkedin } from "../index.ts";
import { unipileWorld } from "./live.ts";

/** Made up for the run, so that no string in the repository looks like a key or a secret. */
const KEY = randomBytes(24).toString("base64url");
const SECRET = randomBytes(32).toString("hex");
const CURSOR_SECRET = randomBytes(32).toString("base64url");
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const ACCOUNT = "fixture-account";
const POST = "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/";
const SOCIAL = "urn:li:activity:7000000000000000001";
const LINKEDIN = "https://www.linkedin.com";
const RETURN_URLS = {
  successUrl: "https://app.whytide.test/w/acme/linkedin/connected",
  failureUrl: "https://app.whytide.test/w/acme/linkedin/failed",
};
const CHAT = "fixture-chat-chidi";
/** The account's own member id (fixtures/account.json), and Ada's, a member's in every fixture. */
const SELF = "fixture-member-self";
const ADA = "fixture-member-ada";
/** The providerRef of the notify fixtures. */
const PAIRED = "whytide-00000000-0000-4000-8000-000000000001";
/** A providerRef's pairing token: its HMAC-SHA-256 under the secret, in base64url. */
const tokenOf = (providerRef: string, secret = SECRET) =>
  createHmac("sha256", secret).update(providerRef).digest("base64url");
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const statusOf = (file: string) => (JSON.parse(fixture(file)) as { status?: number }).status ?? 200;
/** The message fixture's sender, Ada. */
const SENDER = (JSON.parse(fixture("webhook-message-received.json")) as { sender: object }).sender;
const errorFixtures = () =>
  readdirSync(join(import.meta.dirname, "fixtures")).filter((name) => name.startsWith("error"));

/** The fixture for a request: its method, its path and the vendor's cursor it carries. */
const ROUTES: Readonly<Record<string, string>> = {
  "POST /api/v1/hosted/accounts/link": "hosted-link.json",
  [`GET /api/v1/accounts/${ACCOUNT}`]: "account.json",
  "GET /api/v1/posts/7000000000000000001": "post.json",
  // A share's or a ugcPost's URN resolves to an activity's social id, as a share's does at Unipile.
  "GET /api/v1/posts/urn:li:share:7000000000000000002": "post.json",
  "GET /api/v1/posts/urn:li:ugcPost:7000000000000000003": "post.json",
  [`GET /api/v1/posts/${SOCIAL}/reactions`]: "reactions-1.json",
  [`GET /api/v1/posts/${SOCIAL}/reactions reactions-page-2`]: "reactions-2.json",
  [`GET /api/v1/posts/${SOCIAL}/comments`]: "comments-1.json",
  [`GET /api/v1/posts/${SOCIAL}/comments comments-page-2`]: "comments-2.json",
  "GET /api/v1/users/ada-example": "user.json",
  // getRelation asks by the member's provider_id: a stranger, an invited member, a relation.
  "GET /api/v1/users/fixture-member-ada": "user.json",
  "GET /api/v1/users/fixture-member-bao": "relation-invited.json",
  "GET /api/v1/users/fixture-member-chidi": "relation-connected.json",
  "POST /api/v1/users/invite": "invitation-sent.json",
  "DELETE /api/v1/users/invite/sent/fixture-invitation-ada": "invitation-canceled.json",
  "GET /api/v1/users/invite/sent": "invitations-1.json",
  "GET /api/v1/users/invite/sent invitations-page-2": "invitations-2.json",
  "POST /api/v1/chats": "chat-started.json",
  [`POST /api/v1/chats/${CHAT}/messages`]: "message-sent.json",
  "GET /api/v1/chat_attendees/fixture-member-chidi/chats": "member-chats.json",
  [`GET /api/v1/chats/${CHAT}/messages`]: "messages-1.json",
  [`GET /api/v1/chats/${CHAT}/messages messages-page-2`]: "messages-2.json",
};
/** The routes Unipile answers 201 Created. */
const CREATED = new Set(["POST /api/v1/chats", `POST /api/v1/chats/${CHAT}/messages`]);
/**
 * An answer: a fixture, with the status an error fixture holds unless one is given, or a body;
 * `chunked`, sent in pieces with no length; `silent`, never sent.
 */
type Answer = {
  status?: number;
  headers?: Record<string, string>;
  file?: string;
  body?: string;
  chunked?: true;
  silent?: true;
};
/** Each request: `route` with its path decoded, `path` as sent, `form` a multipart body's fields. */
const received: {
  route: string;
  path: string;
  query: Record<string, string>;
  key: unknown;
  body: string;
  form?: Record<string, unknown>;
}[] = [];
/** The next answers, whatever the requests, before ROUTES: a vendor's error; undefined passes. */
const answers: (Answer | undefined)[] = [];
/** Where the log check's child queues its answers (logged-calls.ts); never a request recorded. */
const ANSWERS_PATH = "/__fixture/answers";
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === ANSWERS_PATH) {
    answers.push(JSON.parse(body) as Answer);
    return void response.end();
  }
  const { cursor, ...query } = Object.fromEntries(url.searchParams);
  const route = `${request.method} ${decodeURIComponent(url.pathname)}${cursor ? ` ${cursor}` : ""}`;
  const type = request.headers["content-type"] ?? "";
  const form = type.startsWith("multipart/form-data")
    ? {
        form: Object.fromEntries(
          await new Response(body, { headers: { "content-type": type } }).formData(),
        ),
      }
    : {};
  received.push({
    route,
    path: url.pathname,
    query,
    key: request.headers["x-api-key"],
    body,
    ...form,
  });
  const file = ROUTES[route];
  const routed: Answer = file
    ? { status: CREATED.has(route) ? 201 : 200, file }
    : { status: 404, file: "error.json" };
  const answer = answers.shift() ?? routed;
  if (answer.silent) return;
  const status = answer.status ?? (answer.file ? statusOf(answer.file) : 200);
  const text = answer.body ?? fixture(answer.file ?? "error.json");
  response.writeHead(status, { "content-type": "application/json", ...answer.headers });
  if (!answer.chunked) return void response.end(text);
  for (let at = 0; at < text.length; at += 65_536) response.write(text.slice(at, at + 65_536));
  response.end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  received.length = 0;
  answers.length = 0;
});
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const options = {
  baseUrl,
  apiKey: KEY,
  webhookSecret: SECRET,
  cursorSecret: CURSOR_SECRET,
  notifyUrl: "https://api.whytide.test/v1/linkedin/webhooks/unipile",
  now: () => NOW,
};
const linkedin = bindPort(linkedinPort, unipileLinkedin(options), { adapter: "unipile" });
const fails = (code: string, details?: Record<string, unknown>) => (error: unknown) => {
  assert.ok(isAppError(error) && error.code === code, `${code}, not ${String(error)}`);
  if (details) assert.deepEqual(error.details, details);
  return true;
};

test("a user response with emails, phones and profile_picture_url maps to a Profile without them", async () => {
  received.length = 0;
  const profileUrl = "https://www.linkedin.com/in/ada-example/";
  assert.deepEqual(await linkedin.getProfile({ providerAccountRef: ACCOUNT, profileUrl }), {
    providerMemberRef: "fixture-member-ada",
    profileUrl: "https://www.linkedin.com/in/ada-example",
    firstName: "Ada",
    lastName: "Example",
    headline: "Head of Growth at Example Ltd",
    title: "Head of Growth",
    companyName: "Example Ltd",
    companyUrl: "https://www.linkedin.com/company/example-ltd",
    locationText: "London, United Kingdom",
    industry: "Software Development",
    fetchedAt: new Date(NOW),
  });
  const { contact_info, profile_picture_url } = JSON.parse(fixture("user.json"));
  assert.ok(contact_info.emails.length && contact_info.phones.length && profile_picture_url);
  const query = { account_id: ACCOUNT, linkedin_sections: "experience", notify: "false" };
  assert.deepEqual(
    received.map((request) => [request.route, request.query]),
    [["GET /api/v1/users/ada-example", query]],
  );
});

test("reactions and comments merge into engagers newest first, with a cursor over both lists; no contact data crosses", async () => {
  received.length = 0;
  const read = (cursor?: string | null) =>
    linkedin.listPostEngagers({
      providerAccountRef: ACCOUNT,
      postUrl: POST,
      limit: 2,
      ...(cursor ? { cursor } : {}),
    });
  const pages = [await read()];
  while (pages.length < 5 && pages.at(-1)?.nextCursor)
    pages.push(await read(pages.at(-1)?.nextCursor));
  /** A fixture's engager: a reaction is dated by the listing's start, NOW, a comment by itself. */
  const engager = (name: string, at: string | number, commentText?: string) => ({
    providerMemberRef: `fixture-member-${name.split(" ")[0]?.toLowerCase()}`,
    profileUrl: `https://www.linkedin.com/in/${name.toLowerCase().replace(" ", "-")}`,
    name,
    headline: "Founder at Blue Harbor Labs",
    reaction: commentText === undefined ? "like" : "comment",
    ...(commentText === undefined ? {} : { commentText }),
    engagedAt: new Date(at),
  });
  assert.deepEqual(
    pages.map((page) => page.engagers),
    [
      [
        engager("Dana Specimen", "2026-10-03T09:00:00Z", "Useful, thanks"),
        engager("Bao Sample", NOW),
      ],
      [engager("Chidi Fixture", NOW), engager("Elif Placeholder", NOW)],
      [
        engager("Femi Testwell", "2026-10-02T09:00:00Z", "How does it handle ten sources?"),
        engager("Greta Mockridge", "2026-10-01T09:00:00Z", "Following"),
      ],
    ],
  );
  assert.equal(pages[2]?.nextCursor, null);
  assert.ok(
    fixture("reactions-1.json").includes('"emails"'),
    "the vendor's author held contact data",
  );
  assert.deepEqual(await read(pages[0]?.nextCursor), pages[1], "the cursor reads again");
  // The first page resolves the post, once; every page reads both lists from the cursor's positions.
  const calls = received.map(({ route, query }) => [route, query.account_id, query.limit]);
  assert.deepEqual(calls.slice(0, 3), [
    ["GET /api/v1/posts/7000000000000000001", ACCOUNT, undefined],
    [`GET /api/v1/posts/${SOCIAL}/reactions`, ACCOUNT, "2"],
    [`GET /api/v1/posts/${SOCIAL}/comments`, ACCOUNT, "2"],
  ]);
  assert.equal(calls.filter(([route]) => route === calls[0]?.[0]).length, 1);
});

test("a /posts/ link of a share asks Unipile for urn:li:share:<id> and reads the post's engagers", async () => {
  const { names, paths } = await readPage(
    `${LINKEDIN}/posts/ada-example_fixture-share-7000000000000000002-AbCd`,
  );
  const social = `/api/v1/posts/${encodeURIComponent(SOCIAL)}`;
  assert.deepEqual(paths, [
    "/api/v1/posts/urn%3Ali%3Ashare%3A7000000000000000002",
    `${social}/reactions`,
    `${social}/comments`,
  ]);
  assert.deepEqual(names, ["Dana Specimen", "Bao Sample"]);
});

test("a /posts/ link of a ugcPost asks Unipile for urn:li:ugcPost:<id>", async () => {
  const link = `${LINKEDIN}/posts/ada-example_fixture-ugcPost-7000000000000000003-AbCd`;
  const { paths } = await readPage(link);
  assert.equal(paths[0], "/api/v1/posts/urn%3Ali%3AugcPost%3A7000000000000000003");
});

test("an activity link, in both forms, asks for the post's number; its signed cursor resumes, and one unsigned, as written before the signing, is linkedin_input_invalid", async () => {
  // What the adapter gives after a first page of two: `post` holds the number.
  const written = {
    post: "7000000000000000001",
    social: SOCIAL,
    at: NOW,
    reactions: [null, 1],
    comments: [null, 1],
  };
  const cursor = signedCursors(CURSOR_SECRET).sign("listPostEngagers", written);
  const unsigned = Buffer.from(JSON.stringify(written)).toString("base64url");
  const links = [`${LINKEDIN}/posts/ada-example_fixture-activity-7000000000000000001-AbCd`, POST];
  for (const postUrl of links) {
    assert.equal((await readPage(postUrl)).paths[0], "/api/v1/posts/7000000000000000001");
    const resumed = await readPage(postUrl, cursor);
    assert.deepEqual(resumed.names, ["Chidi Fixture", "Elif Placeholder"]);
    await assert.rejects(readPage(postUrl, unsigned), fails("linkedin_input_invalid"));
  }
});

test("a /feed/update/ link reads an activity, a share and a ugcPost, each colon plain or %3A", async () => {
  const asked = {
    "activity:7000000000000000001": "/api/v1/posts/7000000000000000001",
    "share:7000000000000000002": "/api/v1/posts/urn%3Ali%3Ashare%3A7000000000000000002",
    "ugcPost:7000000000000000003": "/api/v1/posts/urn%3Ali%3AugcPost%3A7000000000000000003",
  };
  for (const [urn, path] of Object.entries(asked)) {
    for (const colon of [":", "%3A", "%3a"]) {
      const link = `${LINKEDIN}/feed/update/urn${colon}li${colon}${urn.replace(":", colon)}`;
      assert.equal((await readPage(link)).paths[0], path, link);
    }
  }
});

test("in a /posts/ slug the last -<kind>-<id>- wins: a -share-40- before the real -activity-<id>- never counts", async () => {
  const link = `${LINKEDIN}/posts/ada-example_market-share-40-up-activity-7000000000000000001-AbCd`;
  assert.equal((await readPage(link)).paths[0], "/api/v1/posts/7000000000000000001");
});

test("a link of no known form is linkedin_not_found, and nothing is asked of Unipile", async () => {
  received.length = 0;
  // The unanchored patterns before the fix took a number from each of these but the comment's.
  const paths = [
    "/in/ada-example-activity-7000000000000000001/",
    "/posts/ada-example_fixture-activity-7000000000000000001",
    "/feed/update/urn:li:comment:7000000000000000001/",
    "/feed/update/urn:li:activity:7000000000000000001/comments",
  ];
  for (const path of paths) {
    const input = { providerAccountRef: ACCOUNT, postUrl: `${LINKEDIN}${path}`, limit: 2 };
    await assert.rejects(
      linkedin.listPostEngagers(input),
      fails("linkedin_not_found", { method: "listPostEngagers" }),
    );
  }
  assert.deepEqual(received, []);
});

test("createHostedAuthLink asks for a single-use LinkedIn link with our URLs, the expiry and the notify address; getAccountStatus reads the sources", async () => {
  received.length = 0;
  const link = await linkedin.createHostedAuthLink({ ...RETURN_URLS, expiresInMin: 30 });
  assert.match(link.providerRef, /^whytide-[0-9a-f-]{36}$/);
  assert.deepEqual(link, {
    url: "https://account.unipile.com/fixture-hosted-link",
    expiresAt: new Date(NOW + 30 * 60_000),
    providerRef: link.providerRef,
  });
  assert.equal(received[0]?.route, "POST /api/v1/hosted/accounts/link");
  assert.deepEqual(JSON.parse(received[0]?.body ?? ""), {
    type: "create",
    providers: ["LINKEDIN"],
    api_url: baseUrl,
    expiresOn: "2026-10-02T12:30:00.000Z",
    success_redirect_url: RETURN_URLS.successUrl,
    failure_redirect_url: RETURN_URLS.failureUrl,
    notify_url: options.notifyUrl,
    name: `${link.providerRef}.${tokenOf(link.providerRef)}`,
    single_use: true,
    disabled_options: ["cookie_auth"],
  });
  const status = { status: "connected", checkedAt: new Date(NOW), memberRef: SELF };
  assert.deepEqual(await linkedin.getAccountStatus(ACCOUNT), status);
});

test("the notify of a link createHostedAuthLink made, as Unipile sends it, pairs: account.connected with the link's providerRef, its name <providerRef>.<token>", async () => {
  received.length = 0;
  const link = await linkedin.createHostedAuthLink({ ...RETURN_URLS, expiresInMin: 30 });
  const { name } = JSON.parse(received[0]?.body ?? "") as { name: string };
  assert.equal(name, `${link.providerRef}.${tokenOf(link.providerRef)}`);
  assert.equal(name.length, 88);
  const paired = {
    kind: "account.connected",
    providerAccountRef: ACCOUNT,
    providerRef: link.providerRef,
  };
  // Unipile's notify: no header, no signature; the body as text and as the bytes the host reads.
  const notify = JSON.stringify({ status: "CREATION_SUCCESS", account_id: ACCOUNT, name });
  for (const rawBody of [notify, new TextEncoder().encode(notify)]) {
    const headers = { "content-type": "application/json" };
    assert.deepEqual(await linkedin.parseWebhook({ headers, rawBody }), paired);
  }
  // The fixtures: its own token pairs, as CREATION_SUCCESS and RECONNECTED; a wrong one and none do not.
  const good = fixture("webhook-notify-token.json").replace("<token>", tokenOf(PAIRED));
  const pairedFixture = { ...paired, providerRef: PAIRED };
  for (const rawBody of [good, good.replace("CREATION_SUCCESS", "RECONNECTED")]) {
    assert.deepEqual(await linkedin.parseWebhook({ headers: {}, rawBody }), pairedFixture);
  }
  const token = { method: "parseWebhook", reason: "token" };
  for (const file of ["webhook-notify-wrong-token.json", "webhook-notify.json"]) {
    const webhook = { headers: {}, rawBody: fixture(file) };
    await assert.rejects(linkedin.parseWebhook(webhook), fails("linkedin_webhook_invalid", token));
  }
});

test("a notify with a wrong token, none, or another providerRef's is linkedin_webhook_invalid before its account id is read; with its token but no notify, for its body", async () => {
  const notify = (name: string, status = "CREATION_SUCCESS") => ({
    headers: {},
    rawBody: JSON.stringify({ status, account_id: ACCOUNT, name }),
  });
  const other = "whytide-00000000-0000-4000-8000-000000000002";
  const refused = [
    notify(`${PAIRED}.${tokenOf(other)}`),
    notify(`${other}.${tokenOf(PAIRED)}`),
    notify(`${PAIRED}.${tokenOf(PAIRED, randomBytes(32).toString("hex"))}`),
    notify(PAIRED),
    notify(`${PAIRED}.`),
  ];
  const token = { method: "parseWebhook", reason: "token" };
  for (const webhook of refused) {
    await assert.rejects(linkedin.parseWebhook(webhook), fails("linkedin_webhook_invalid", token));
  }
  // Its token, but no notify: another status, or a source's header, whose body is no source event.
  const own = `${PAIRED}.${tokenOf(PAIRED)}`;
  const body = { method: "parseWebhook", reason: "body" };
  for (const webhook of [notify(own, "CREATION_FAIL"), signed(notify(own).rawBody)]) {
    await assert.rejects(linkedin.parseWebhook(webhook), fails("linkedin_webhook_invalid", body));
  }
});

test("each source's event maps from its fixture: a reply, the account's own message and a new relation; a reaction, a read receipt and an edit are ignored", async () => {
  const reply = {
    kind: "message.received",
    providerAccountRef: ACCOUNT,
    eventKey: "fixture-message-ada-1",
    chatRef: "fixture-chat-ada",
    messageRef: "fixture-message-ada-1",
    senderMemberRef: ADA,
    fromAccount: false,
    attendeeMemberRefs: [ADA],
    text: "fixture-body-marker: happy to talk next week.",
    sentAt: new Date("2026-10-02T11:30:00.000Z"),
  };
  const inbound = signed(fixture("webhook-message-received.json"));
  assert.deepEqual(await linkedin.parseWebhook(inbound), reply);
  // The account's own message: its sender is the account's user_id.
  const ownId = "fixture-message-self-2";
  const own = message({ message_id: ownId, sender: { ...SENDER, attendee_provider_id: SELF } });
  assert.deepEqual(await linkedin.parseWebhook(signed(own)), {
    ...reply,
    eventKey: ownId,
    messageRef: ownId,
    senderMemberRef: SELF,
    fromAccount: true,
  });
  // An attachment alone: no text.
  const attachment = message({ message: null });
  assert.deepEqual(await linkedin.parseWebhook(signed(attachment)), { ...reply, text: "" });
  assert.deepEqual(await linkedin.parseWebhook(signed(fixture("webhook-new-relation.json"))), {
    kind: "invite.accepted",
    providerAccountRef: ACCOUNT,
    eventKey: `new_relation:${ACCOUNT}:${ADA}`,
    memberRef: ADA,
  });
  for (const name of ["reaction", "read", "edited"]) {
    const webhook = signed(fixture(`webhook-message-${name}.json`));
    assert.deepEqual(await linkedin.parseWebhook(webhook), { kind: "ignored" }, name);
  }
});

test("every account status maps as listed: OK, RECONNECTED, CREATION_SUCCESS and SYNC_SUCCESS connected, CREDENTIALS credentials_required, any other disconnected, an unknown one included", async () => {
  const listed: Readonly<Record<string, string>> = {
    "webhook-status-ok.json": "account.connected",
    "webhook-status-reconnected.json": "account.connected",
    "webhook-status-creation-success.json": "account.connected",
    "webhook-status-sync-success.json": "account.connected",
    "webhook-status-credentials.json": "account.credentials_required",
    "webhook-status-error.json": "account.disconnected",
    "webhook-status-stopped.json": "account.disconnected",
    "webhook-status-deleted.json": "account.disconnected",
    "webhook-status-connecting.json": "account.disconnected",
    "webhook-status-unknown.json": "account.disconnected",
  };
  const files = readdirSync(join(import.meta.dirname, "fixtures")).filter((name) =>
    name.startsWith("webhook-status-"),
  );
  assert.deepEqual(files.toSorted(), Object.keys(listed).toSorted(), "each status fixture listed");
  for (const [name, kind] of Object.entries(listed)) {
    const event = await linkedin.parseWebhook(signed(fixture(name)));
    assert.deepEqual(event, { kind, providerAccountRef: ACCOUNT }, name);
  }
});

test("a message whose sender id or account id is missing maps with fromAccount false: without the sender's id, from the chat's one attendee; with neither, linkedin_webhook_invalid", async () => {
  /** The sender and the side a message event gives. */
  const sideOf = async (rawBody: string) => {
    const event = await linkedin.parseWebhook(signed(rawBody));
    assert.ok(event.kind === "message.received", event.kind);
    return [event.senderMemberRef, event.fromAccount];
  };
  const noSenderId = message({ sender: { ...SENDER, attendee_provider_id: undefined } });
  const emptySenderId = message({ sender: { ...SENDER, attendee_provider_id: "" } });
  for (const body of [noSenderId, emptySenderId, message({ sender: null })]) {
    assert.deepEqual(await sideOf(body), [ADA, false]);
  }
  // The account's own message, without the account's id, reads as inbound: a hold, the safe side.
  const self = { sender: { ...SENDER, attendee_provider_id: SELF } };
  for (const accountInfo of [undefined, null, { type: "LINKEDIN" }]) {
    assert.deepEqual(await sideOf(message({ ...self, account_info: accountInfo })), [SELF, false]);
  }
  const body = { method: "parseWebhook", reason: "body" };
  const two = [{ attendee_provider_id: ADA }, { attendee_provider_id: "fixture-member-bao" }];
  for (const attendees of [[], null, two]) {
    const webhook = signed(message({ sender: null, attendees }));
    await assert.rejects(linkedin.parseWebhook(webhook), fails("linkedin_webhook_invalid", body));
  }
});

test("one synthetic member id gives the same ref as a profile's providerMemberRef, an acceptance's memberRef and a reply's senderMemberRef", async () => {
  const profileUrl = "https://www.linkedin.com/in/ada-example/";
  const profile = await linkedin.getProfile({ providerAccountRef: ACCOUNT, profileUrl });
  const accepted = await linkedin.parseWebhook(signed(fixture("webhook-new-relation.json")));
  const replied = await linkedin.parseWebhook(signed(fixture("webhook-message-received.json")));
  assert.ok(accepted.kind === "invite.accepted" && replied.kind === "message.received");
  const refs = [profile.providerMemberRef, accepted.memberRef, replied.senderMemberRef];
  assert.deepEqual(refs, [ADA, ADA, ADA]);
});

test("getAccountStatus answers the account's own member id from its details, connection_params.im.id, and null when they have none", async () => {
  const status = { status: "connected", checkedAt: new Date(NOW) };
  assert.deepEqual(await linkedin.getAccountStatus(ACCOUNT), { ...status, memberRef: SELF });
  answers.push({ file: "account-without-member.json" });
  assert.deepEqual(await linkedin.getAccountStatus(ACCOUNT), { ...status, memberRef: null });
});

test("a wrong or missing Unipile-Auth header on any of the three sources is linkedin_webhook_invalid, whatever the body; a verified body that is not Unipile's, for its body", async () => {
  const header = { method: "parseWebhook", reason: "secret" };
  const missing = { method: "parseWebhook", reason: "token" };
  const sources = [
    "webhook-message-received.json",
    "webhook-new-relation.json",
    "webhook-status-credentials.json",
  ];
  for (const name of sources) {
    const rawBody = fixture(name);
    for (const secret of [`${SECRET}0`, SECRET.slice(1), [SECRET, SECRET], ""]) {
      const refused = linkedin.parseWebhook(signed(rawBody, secret));
      await assert.rejects(refused, fails("linkedin_webhook_invalid", header));
    }
    for (const headers of [{}, { "content-type": "application/json" }]) {
      const refused = linkedin.parseWebhook({ headers, rawBody });
      await assert.rejects(refused, fails("linkedin_webhook_invalid", missing));
    }
  }
  const body = { method: "parseWebhook", reason: "body" };
  const relation = JSON.parse(fixture("webhook-new-relation.json")) as Record<string, unknown>;
  const offShape = [
    "not json",
    "[]",
    "{}",
    JSON.stringify({ event: 7 }),
    message({ message_id: undefined }),
    message({ chat_id: "" }),
    message({ timestamp: "not a time" }),
    JSON.stringify({ ...relation, user_provider_id: undefined }),
    JSON.stringify({ AccountStatus: { message: "OK" } }),
    JSON.stringify({ AccountStatus: "OK", event: "message_reaction" }),
  ];
  for (const rawBody of offShape) {
    const refused = linkedin.parseWebhook(signed(rawBody));
    await assert.rejects(refused, fails("linkedin_webhook_invalid", body), rawBody);
  }
});

test("the contract's event cases pass on Unipile's world, which has no account.status to send", async (t) => {
  const world = unipileWorld({ UNIPILE_WEBHOOK_SECRET: SECRET });
  const cases = linkedinCases(world);
  const sent = LINKEDIN_WEBHOOK_KINDS.filter((kind) => kind !== "account.status");
  const parses = "a signed event parses to its shape; forged or unsigned, linkedin_webhook_invalid";
  const titles = [
    ...sent.map((kind) => `${kind}: ${parses}`),
    "an event delivered twice gives the same eventKey; two messages give two keys",
  ];
  for (const title of titles) {
    const run = cases[title];
    assert.ok(run, title);
    await t.test(title, (subtest) => run(linkedin, subtest));
  }
  assert.equal(await world.event?.("account.status"), undefined);
});

test("the vendor's errors are the port's codes, a 429 with Retry-After: 30 retryAfterSec 30; no key or body in an error or a log line", async (t) => {
  const logs = collectLogs();
  const logger = createLogger({ destination: logs.destination });
  const printed = consoleOf(t);
  const errors: unknown[] = [];
  const cases: [Answer, string, Record<string, unknown>][] = [
    [
      { status: 429, headers: { "retry-after": "30" }, file: "error.json" },
      "linkedin_rate_limited",
      { retryAfterSec: 30 },
    ],
    [
      { status: 401, file: "error-disconnected.json" },
      "linkedin_account_disconnected",
      { reason: "disconnected", type: "errors/disconnected_account" },
    ],
    [{ status: 404, file: "error.json" }, "linkedin_not_found", {}],
    [
      { status: 500, file: "error.json" },
      "linkedin_provider_error",
      { status: 500, type: "errors/unexpected_error" },
    ],
  ];
  for (const [answer, code, details] of cases) {
    answers.push(answer);
    const error = await linkedin
      .createHostedAuthLink({ ...RETURN_URLS, expiresInMin: 30 })
      .catch((e: unknown) => e);
    fails(code, { method: "createHostedAuthLink", ...details })(error);
    errors.push(error);
  }
  const spare = createServer().listen(0, "127.0.0.1");
  await once(spare, "listening");
  const closed = `http://127.0.0.1:${(spare.address() as AddressInfo).port}`;
  spare.close();
  const offline = unipileLinkedin({ ...options, baseUrl: closed });
  const unreachable = await offline.getAccountStatus(ACCOUNT).catch((e: unknown) => e);
  const refused = { method: "getAccountStatus", reason: "unreachable", code: "ECONNREFUSED" };
  fails("linkedin_provider_error", refused)(unreachable);
  errors.push(unreachable);
  for (const err of errors) logger.error({ err }, "linkedin call failed");
  const seen = inspect([errors, logs.raw, printed], {
    depth: Number.POSITIVE_INFINITY,
    showHidden: true,
  });
  const fragments = Array.from({ length: KEY.length - 7 }, (_, at) => KEY.slice(at, at + 8));
  assert.deepEqual(
    fragments.filter((fragment) => seen.includes(fragment)),
    [],
    "the key",
  );
  for (const body of ["fixture-body-marker", RETURN_URLS.successUrl]) {
    assert.ok(!seen.includes(body), `a body: ${body}`);
  }
  assert.ok(logs.lines().length === errors.length, "the errors were logged");
  assert.ok(received.length > 0 && received.every(({ key }) => key === KEY), "the key was sent");
});

test("a 302 is linkedin_provider_error with status 302 and reason redirect, never followed: one request and no second; a socket the server destroys is reason unreachable with its code", async () => {
  received.length = 0;
  // Followed, the Location would be a second request to this server, for a profile it serves.
  const location = `${baseUrl}/api/v1/users/ada-example`;
  answers.push({ status: 302, headers: { location }, file: "error.json" });
  const profileUrl = "https://www.linkedin.com/in/ada-example/";
  const redirected = await linkedin
    .getProfile({ providerAccountRef: ACCOUNT, profileUrl })
    .catch((e: unknown) => e);
  const redirect = { method: "getProfile", status: 302, reason: "redirect" };
  fails("linkedin_provider_error", redirect)(redirected);
  assert.equal(received.length, 1);
  const seen = inspect(redirected, { depth: Number.POSITIVE_INFINITY, showHidden: true });
  assert.ok(!seen.includes(location), "the Location is not kept");

  const dropping = createServer((request) => request.socket.destroy()).listen(0, "127.0.0.1");
  await once(dropping, "listening");
  const dropped = `http://127.0.0.1:${(dropping.address() as AddressInfo).port}`;
  const reset = await unipileLinkedin({ ...options, baseUrl: dropped })
    .getAccountStatus(ACCOUNT)
    .catch((e: unknown) => e);
  dropping.close();
  const unreachable = { method: "getAccountStatus", reason: "unreachable", code: "UND_ERR_SOCKET" };
  fails("linkedin_provider_error", unreachable)(reset);
});

const account = { providerAccountRef: ACCOUNT };
const ada = { ...account, memberRef: "fixture-member-ada" };
const chidi = { ...account, memberRef: "fixture-member-chidi" };
const SINCE = new Date("2026-10-02T00:00:00.000Z");

test("sendInvite posts the account and the member, and the note as message only when it has text", async () => {
  const bodies: unknown[] = [];
  for (const note of [undefined, "", " \n ", "Hello Ada, we met at the meetup."]) {
    const invite = {
      ...ada,
      idempotencyKey: "step-key-1",
      ...(note === undefined ? {} : { note }),
    };
    const sent = { invitationRef: "fixture-invitation-ada", sentAt: new Date(NOW) };
    assert.deepEqual(await linkedin.sendInvite(invite), sent);
    bodies.push(JSON.parse(received.at(-1)?.body ?? ""));
  }
  const body = { account_id: ACCOUNT, provider_id: "fixture-member-ada" };
  const message = "Hello Ada, we met at the meetup.";
  assert.deepEqual(bodies, [body, body, body, { ...body, message }]);
  assert.deepEqual(
    new Set(received.map(({ route }) => route)),
    new Set(["POST /api/v1/users/invite"]),
  );
});

test("withdrawInvite deletes the invitation sent; listPendingInvites pages under a signed cursor, dropping a row without its member", async () => {
  const withdrawn = await linkedin.withdrawInvite({
    ...account,
    invitationRef: "fixture-invitation-ada",
  });
  assert.deepEqual(withdrawn, { withdrawnAt: new Date(NOW) });
  const first = await linkedin.listPendingInvites(account);
  const pending = (name: string, at: string | number) => ({
    invitationRef: `fixture-invitation-${name}`,
    memberRef: `fixture-member-${name}`,
    sentAt: new Date(at),
  });
  // Bao's invitation has no parsed time: it takes the listing's.
  assert.deepEqual(first.invites, [
    pending("ada", "2026-09-30T08:00:00.000Z"),
    pending("bao", NOW),
  ]);
  const cursor = first.nextCursor ?? assert.fail("a second page");
  assert.ok(cursor.includes("."), "a signed cursor");
  assert.deepEqual(await linkedin.listPendingInvites({ ...account, cursor }), {
    invites: [pending("chidi", "2026-09-11T08:00:00.000Z")],
    nextCursor: null,
  });
  const page = { account_id: ACCOUNT, limit: "100" };
  assert.deepEqual(
    received.map(({ route, query }) => [route, query]),
    [
      ["DELETE /api/v1/users/invite/sent/fixture-invitation-ada", { account_id: ACCOUNT }],
      ["GET /api/v1/users/invite/sent", page],
      ["GET /api/v1/users/invite/sent invitations-page-2", page],
    ],
  );
});

test("getRelation reads the network distance and an invitation the account sent, with no profile view", async () => {
  const relation = (memberRef: string) => linkedin.getRelation({ ...account, memberRef });
  const none = { connected: false, invitationPending: false };
  assert.deepEqual(await relation("fixture-member-ada"), none);
  assert.deepEqual(await relation("fixture-member-bao"), { ...none, invitationPending: true });
  // Chidi is a relation, and the invitation pending is one the account received: not the account's.
  assert.deepEqual(await relation("fixture-member-chidi"), { ...none, connected: true });
  const query = { account_id: ACCOUNT, notify: "false" };
  assert.deepEqual(
    received.map((request) => request.query),
    [query, query, query],
  );
});

test("sendMessage posts a form to the chat given, else starts a chat with the member as its one attendee", async () => {
  const message = { ...chidi, text: "Thanks for the reply!", idempotencyKey: "step-key-2" };
  assert.deepEqual(await linkedin.sendMessage({ ...message, chatRef: CHAT }), {
    messageRef: "fixture-message-chidi-3",
    chatRef: CHAT,
    sentAt: new Date(NOW),
  });
  assert.deepEqual(await linkedin.sendMessage({ ...message, ...ada, text: "Hello Ada" }), {
    messageRef: "fixture-message-ada-1",
    chatRef: "fixture-chat-ada",
    sentAt: new Date(NOW),
  });
  assert.deepEqual(
    received.map(({ route, form }) => [route, form]),
    [
      [`POST /api/v1/chats/${CHAT}/messages`, { account_id: ACCOUNT, text: message.text }],
      [
        "POST /api/v1/chats",
        { account_id: ACCOUNT, attendees_ids: "fixture-member-ada", text: "Hello Ada" },
      ],
    ],
  );
  // Unipile's reference allows a send answered without its ids: the caller checks the outcome
  // before any retry, and no ref is made up.
  const unnamed = { method: "sendMessage", reason: "no id in the answer" };
  answers.push({ status: 201, body: '{"object":"MessageSent","message_id":null}' });
  await assert.rejects(
    linkedin.sendMessage({ ...message, chatRef: CHAT }),
    fails("linkedin_provider_error", unnamed),
  );
  answers.push({ status: 201, body: '{"object":"ChatStarted","chat_id":null,"message_id":"m-1"}' });
  await assert.rejects(linkedin.sendMessage(message), fails("linkedin_provider_error", unnamed));
});

test("listRecentMessages finds the member's chat of the account's, reads its pages since the time given, and keeps refs, sides and times, never text", async () => {
  const recent = { ...chidi, since: SINCE };
  const message = (n: number, fromAccount: boolean, at: string) => ({
    messageRef: `fixture-message-chidi-${n}`,
    chatRef: CHAT,
    fromAccount,
    sentAt: new Date(at),
  });
  // Oldest first; the message before SINCE is dropped, the other account's chat never read.
  const messages = [
    message(1, true, "2026-10-02T10:00:00.000Z"),
    message(2, false, "2026-10-02T11:00:00.000Z"),
    message(3, true, "2026-10-02T11:30:00.000Z"),
  ];
  assert.deepEqual(await linkedin.listRecentMessages(recent), { messages });
  const page = { after: SINCE.toISOString(), limit: "100" };
  assert.deepEqual(
    received.map(({ route, query }) => [route, query]),
    [
      [
        "GET /api/v1/chat_attendees/fixture-member-chidi/chats",
        { account_id: ACCOUNT, limit: "10" },
      ],
      [`GET /api/v1/chats/${CHAT}/messages`, page],
      [`GET /api/v1/chats/${CHAT}/messages messages-page-2`, page],
    ],
  );
  received.length = 0;
  assert.deepEqual(await linkedin.listRecentMessages({ ...recent, chatRef: CHAT }), { messages });
  assert.equal(received.length, 2, "the chat given: no lookup");
  // A member in no chat Unipile knows of: no messages.
  answers.push({ status: 404, file: "error.json" });
  assert.deepEqual(await linkedin.listRecentMessages(recent), { messages: [] });
});

test("every error fixture is its port code on each send-side method: a limit, a disconnect or a refusal with its reason, a 429, a 5xx", async () => {
  const calls = {
    sendInvite: () => linkedin.sendInvite({ ...ada, idempotencyKey: "step-key-1" }),
    sendMessage: () =>
      linkedin.sendMessage({ ...ada, text: "Hello", idempotencyKey: "step-key-2" }),
    withdrawInvite: () =>
      linkedin.withdrawInvite({ ...account, invitationRef: "fixture-invitation" }),
    listPendingInvites: () => linkedin.listPendingInvites(account),
    listRecentMessages: () =>
      linkedin.listRecentMessages({ ...chidi, chatRef: CHAT, since: SINCE }),
    getRelation: () => linkedin.getRelation(ada),
  };
  const disconnected = (reason: string) => ({ code: "linkedin_account_disconnected", reason });
  const refused = (reason: string) => ({ code: "linkedin_send_refused", reason });
  const expected: Record<string, { code: string; [detail: string]: unknown }> = {
    "error-cannot-resend-yet.json": { code: "linkedin_limit_reached" },
    "error-restricted.json": disconnected("restricted"),
    "error-checkpoint.json": disconnected("checkpoint"),
    "error-expired-credentials.json": disconnected("credentials_required"),
    "error-disconnected.json": disconnected("disconnected"),
    "error-already-invited.json": refused("already_invited"),
    "error-already-connected.json": refused("already_connected"),
    "error-not-connected.json": refused("not_connected"),
    "error-recipient-unavailable.json": refused("recipient_unavailable"),
    // No Retry-After header: the default, never the body's retry_after.
    "error-rate-limited.json": { code: "linkedin_rate_limited", retryAfterSec: 60 },
    "error.json": { code: "linkedin_provider_error", status: 500 },
  };
  assert.deepEqual(Object.keys(expected).toSorted(), errorFixtures().toSorted());
  for (const [file, { code, ...details }] of Object.entries(expected)) {
    const { type } = JSON.parse(fixture(file)) as { type: string };
    const typed = code === "linkedin_rate_limited" ? details : { ...details, type };
    for (const [method, call] of Object.entries(calls)) {
      answers.push({ file });
      await assert.rejects(call(), fails(code, { method, ...typed }), `${file}, ${method}`);
    }
  }
});

test("a timeout, a redirect and a 503 on a send are linkedin_provider_error after one request, never retried", async () => {
  // The timeout made short for the run, for the silent answer only.
  const quick = bindPort(linkedinPort, unipileLinkedin({ ...options, timeoutMs: 100 }), {
    adapter: "unipile",
  });
  const sends = (adapter: typeof linkedin) => ({
    sendInvite: () => adapter.sendInvite({ ...ada, idempotencyKey: "step-key-1" }),
    sendMessage: () => adapter.sendMessage({ ...ada, text: "Hello", idempotencyKey: "step-key-2" }),
  });
  const cases: [Answer, Record<string, unknown>][] = [
    [{ silent: true }, { reason: "timeout" }],
    [
      { status: 302, headers: { location: `${baseUrl}/api/v1/chats` } },
      { status: 302, reason: "redirect" },
    ],
    [
      { status: 503, file: "error.json" },
      { status: 503, type: "errors/unexpected_error" },
    ],
  ];
  for (const [answer, details] of cases) {
    for (const [method, send] of Object.entries(sends(answer.silent ? quick : linkedin))) {
      received.length = 0;
      answers.push(answer);
      await assert.rejects(send(), fails("linkedin_provider_error", { method, ...details }));
      assert.equal(received.length, 1, `${method}: one request`);
    }
  }
});

test("an answer above MAX_ANSWER_BYTES is linkedin_provider_error answer_too_large, unparsed, its length declared or not; one of exactly the limit is read", async () => {
  // A success the adapter maps, padded to a size: parsed, it would be an invitation.
  const padded = (bytes: number) => {
    const start = '{"invitation_id":"fixture-invitation-ada","padding":"';
    return `${start}${"x".repeat(bytes - start.length - 2)}"}`;
  };
  const invite = () => linkedin.sendInvite({ ...ada, idempotencyKey: "step-key-1" });
  const tooLarge = (status: number) =>
    fails("linkedin_provider_error", { method: "sendInvite", status, reason: "answer_too_large" });
  const large = padded(MAX_ANSWER_BYTES + 1);
  answers.push({ status: 201, body: large, headers: { "content-length": String(large.length) } });
  await assert.rejects(invite(), tooLarge(201));
  answers.push({ status: 201, body: large, chunked: true });
  await assert.rejects(invite(), tooLarge(201));
  // A vendor error as large is not read for its type either.
  const limit = JSON.stringify({ type: "errors/cannot_resend_yet", detail: large });
  answers.push({ status: 422, body: limit, chunked: true });
  await assert.rejects(invite(), tooLarge(422));
  answers.push({ status: 201, body: padded(MAX_ANSWER_BYTES), chunked: true });
  assert.equal((await invite()).invitationRef, "fixture-invitation-ada");
});

test("a cursor the adapter did not give, forged, unsigned, or of another post, account or method, is linkedin_input_invalid before any request", async () => {
  const { sign } = signedCursors(CURSOR_SECRET);
  const forge = signedCursors(randomBytes(32).toString("base64url")).sign;
  const unsigned = (state: unknown) => Buffer.from(JSON.stringify(state)).toString("base64url");
  const post = {
    post: "7000000000000000001",
    social: SOCIAL,
    at: NOW,
    reactions: null,
    comments: null,
  };
  const page = { account: ACCOUNT, vendor: "invitations-page-2" };
  const share = `${LINKEDIN}/posts/ada-example_fixture-share-7000000000000000002-AbCd`;
  const engagers =
    (cursor: string, postUrl = POST) =>
    () =>
      linkedin.listPostEngagers({ ...account, postUrl, limit: 2, cursor });
  const pending =
    (cursor: string, providerAccountRef = ACCOUNT) =>
    () =>
      linkedin.listPendingInvites({ providerAccountRef, cursor });
  const cases = [
    [engagers(forge("listPostEngagers", post)), "post"],
    [engagers(unsigned(post)), "post"],
    [engagers(`${unsigned(post)}.`), "post"],
    [engagers(sign("listPostEngagers", post), share), "post"],
    [engagers(sign("listPendingInvites", post)), "post"],
    [pending(forge("listPendingInvites", page)), "account"],
    [pending(unsigned(page)), "account"],
    [pending(sign("listPendingInvites", page), "fixture-account-other"), "account"],
    [pending(sign("listPostEngagers", page)), "account"],
  ] as const;
  for (const [call, of] of cases) {
    const method = of === "post" ? "listPostEngagers" : "listPendingInvites";
    const reason = `a cursor the adapter did not give for this ${of}`;
    await assert.rejects(call(), fails("linkedin_input_invalid", { method, reason }));
  }
  assert.deepEqual(received, [], "no request");
});

test("a vendor cursor that would make a cursor past the port's 2,048 characters is linkedin_provider_error cursor_too_long", async () => {
  const long = "c".repeat(2_000);
  answers.push({ status: 200, body: JSON.stringify({ items: [], cursor: long }) });
  await assert.rejects(
    linkedin.listPendingInvites(account),
    fails("linkedin_provider_error", { method: "listPendingInvites", reason: "cursor_too_long" }),
  );
  // The reactions' page read to its end, the cursor holds its vendor cursor.
  const profile = "https://www.linkedin.com/in/bao-sample";
  const reaction = {
    author: { id: "fixture-member-bao", name: "Bao Sample", profile_url: profile },
  };
  answers.push({ status: 200, body: JSON.stringify({ items: [reaction], cursor: long }) });
  const first = { post: "7000000000000000001", social: SOCIAL, at: NOW };
  const cursor = signedCursors(CURSOR_SECRET).sign("listPostEngagers", {
    ...first,
    reactions: [null, 0],
    comments: [null, 0],
  });
  await assert.rejects(
    linkedin.listPostEngagers({ ...account, postUrl: POST, limit: 2, cursor }),
    fails("linkedin_provider_error", { method: "listPostEngagers", reason: "cursor_too_long" }),
  );
});

test("create() is config_invalid naming the variable for a missing one or a secret under 32 characters", async () => {
  const index = pathToFileURL(join(import.meta.dirname, "..", "index.ts")).href;
  const script = `import { unipileAdapter } from ${JSON.stringify(index)};
try { unipileAdapter.create(); console.log('"created"'); }
catch ({ code, details }) { console.log(JSON.stringify({ code, variables: details?.variables })); }`;
  const valid = {
    UNIPILE_BASE_URL: "https://api.unipile.test",
    UNIPILE_API_KEY: KEY,
    UNIPILE_WEBHOOK_SECRET: SECRET,
    UNIPILE_CURSOR_SECRET: CURSOR_SECRET,
  };
  const required = "required by the unipile adapter";
  const short = `at least 32 characters, ${required}`;
  const cases: [Record<string, string | undefined>, string | undefined][] = [
    [{}, undefined],
    [{ UNIPILE_BASE_URL: undefined }, `UNIPILE_BASE_URL: ${required}`],
    [{ UNIPILE_API_KEY: undefined }, `UNIPILE_API_KEY: ${required}`],
    [{ UNIPILE_CURSOR_SECRET: undefined }, `UNIPILE_CURSOR_SECRET: ${short}`],
    [{ UNIPILE_WEBHOOK_SECRET: SECRET.slice(0, 31) }, `UNIPILE_WEBHOOK_SECRET: ${short}`],
    [{ UNIPILE_CURSOR_SECRET: CURSOR_SECRET.slice(0, 31) }, `UNIPILE_CURSOR_SECRET: ${short}`],
  ];
  const outcomes = await Promise.all(
    cases.map(async ([changed]) => {
      const env = { ...childEnv(), ...valid, ...changed };
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env });
      const [output] = await Promise.all([textOf(child.stdout), once(child, "close")]);
      return JSON.parse(output) as unknown;
    }),
  );
  const expected = cases.map(([, variable]) =>
    variable === undefined ? "created" : { code: "config_invalid", variables: [variable] },
  );
  assert.deepEqual(outcomes, expected);
});

test("the log check: every line the adapter's calls write, in a child's stdout and stderr, holds no key, secret, cursor or vendor body", async () => {
  // logged-calls.ts: every method, as it succeeds and through each failure, each error logged.
  const child = spawn(process.execPath, [join(import.meta.dirname, "logged-calls.ts")], {
    env: {
      ...childEnv(),
      LOG_LEVEL: "trace",
      LOG_CHECK_BASE_URL: baseUrl,
      LOG_CHECK_KEY: KEY,
      LOG_CHECK_SECRET: SECRET,
      LOG_CHECK_CURSOR_SECRET: CURSOR_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const [stdout, stderr, reported] = child.stdio.slice(1) as Readable[];
  const [output, errorOutput, report, [code]] = await Promise.all([
    textOf(stdout as Readable),
    textOf(stderr as Readable),
    textOf(reported as Readable),
    once(child, "close"),
  ]);
  assert.equal(code, 0, errorOutput);
  const { cursors, errors } = JSON.parse(report) as { cursors: string[]; errors: number };
  const lines = `${output}\n${errorOutput}`.split("\n").filter(Boolean);
  assert.ok(cursors.length >= 3 && errors >= errorFixtures().length, "the calls ran");
  assert.ok(lines.length >= errors, "each error's line was seen");
  const fragments = [KEY, SECRET, CURSOR_SECRET].flatMap((value) =>
    Array.from({ length: value.length - 7 }, (_, at) => value.slice(at, at + 8)),
  );
  const parts = cursors.flatMap((cursor) => [cursor, ...cursor.split(".")]);
  // The pairing tokens: the notify's, and the one each hosted link was made with, as it was sent.
  const names = received.flatMap(({ route, body }) =>
    route === "POST /api/v1/hosted/accounts/link"
      ? [(JSON.parse(body) as { name: string }).name]
      : [],
  );
  const tokens = [tokenOf(PAIRED), ...names.map((name) => name.slice(name.lastIndexOf(".") + 1))];
  assert.ok(names.length > 0, "a hosted link was made");
  for (const line of lines) {
    assert.deepEqual(
      fragments.filter((fragment) => line.includes(fragment)),
      [],
      "a key or secret",
    );
    assert.deepEqual(
      parts.filter((part) => line.includes(part)),
      [],
      "a cursor",
    );
    assert.deepEqual(
      tokens.filter((token) => line.includes(token)),
      [],
      "a pairing token",
    );
    assert.ok(!line.includes("fixture-body-marker"), "a vendor body");
  }
  assert.ok(received.length > 0 && received.every(({ key }) => key === KEY), "the key was sent");
});

/** A body with the Unipile-Auth header, as Unipile sends a source's event. */
function signed(rawBody: LinkedinWebhook["rawBody"], secret: unknown = SECRET): LinkedinWebhook {
  return {
    headers: { "content-type": "application/json", [SECRET_HEADER]: secret as string },
    rawBody,
  };
}

/** The message fixture with some of its fields replaced, or removed where undefined. */
function message(fields: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(fixture("webhook-message-received.json")), ...fields });
}

/** A page of two of a post's engagers by its link, and the path of each request it sent, as sent. */
async function readPage(postUrl: string, cursor?: string) {
  received.length = 0;
  const input = { providerAccountRef: ACCOUNT, postUrl, limit: 2, ...(cursor ? { cursor } : {}) };
  const page = await linkedin.listPostEngagers(input);
  return { names: page.engagers.map(({ name }) => name), paths: received.map(({ path }) => path) };
}

/** What console prints meanwhile. */
function consoleOf(t: TestContext): unknown[] {
  const printed: unknown[] = [];
  for (const level of ["debug", "info", "log", "warn", "error"] as const) {
    t.mock.method(console, level, (...args: unknown[]) => void printed.push(args));
  }
  return printed;
}

/** A stream's text, once it ends. */
async function textOf(stream: Readable): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

/** The test's environment for a child: no UNIPILE_* variable, proxy or test runner's context. */
function childEnv(): NodeJS.ProcessEnv {
  const inherited = /^(UNIPILE_|NODE_TEST_CONTEXT$|NODE_USE_ENV_PROXY$)|_PROXY$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !inherited.test(name)));
}
