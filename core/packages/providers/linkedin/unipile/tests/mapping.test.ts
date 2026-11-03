// The Unipile adapter's mapping and error tests (README.md "Tests"), offline: unipileLinkedin()
// against a node:http server of the test's own on 127.0.0.1, serving the synthetic fixtures of
// fixtures/ (shaped like Unipile's documentation, never recorded) and recording each request, so
// that the adapter's real request code runs. No vendor is called; the key is made up for the run.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, type TestContext, test } from "node:test";
import { inspect } from "node:util";
import { collectLogs, createLogger, isAppError } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { type LinkedinWebhook, linkedinPort } from "../../port.ts";
import { SECRET_HEADER, unipileLinkedin } from "../index.ts";

/** Made up for the run, so that no string in the repository looks like a key or a secret. */
const KEY = randomBytes(24).toString("base64url");
const SECRET = randomBytes(32).toString("hex");
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const ACCOUNT = "fixture-account";
const POST = "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/";
const SOCIAL = "urn:li:activity:7000000000000000001";
const LINKEDIN = "https://www.linkedin.com";
const RETURN_URLS = {
  successUrl: "https://app.whytide.test/w/acme/linkedin/connected",
  failureUrl: "https://app.whytide.test/w/acme/linkedin/failed",
};
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

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
};
type Answer = { status: number; headers?: Record<string, string>; file: string };
/** Each request: `route` with its path decoded, `path` as sent. */
const received: {
  route: string;
  path: string;
  query: Record<string, string>;
  key: unknown;
  body: string;
}[] = [];
/** The next answer, whatever the request: a vendor's error. */
let failNext: Answer | undefined;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const { cursor, ...query } = Object.fromEntries(url.searchParams);
  const route = `${request.method} ${decodeURIComponent(url.pathname)}${cursor ? ` ${cursor}` : ""}`;
  received.push({ route, path: url.pathname, query, key: request.headers["x-api-key"], body });
  const file = ROUTES[route];
  const answer = failNext ?? (file ? { status: 200, file } : { status: 404, file: "error.json" });
  failNext = undefined;
  response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
  response.end(fixture(answer.file));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => {
  server.closeAllConnections();
  server.close();
});
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const options = {
  baseUrl,
  apiKey: KEY,
  webhookSecret: SECRET,
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

test("an activity link, in both forms, asks for the post's number; a cursor written before the fix resumes", async () => {
  // What the adapter gave after a first page of two before the fix: `post` held the number then too.
  const written = {
    post: "7000000000000000001",
    social: SOCIAL,
    at: NOW,
    reactions: [null, 1],
    comments: [null, 1],
  };
  const cursor = Buffer.from(JSON.stringify(written)).toString("base64url");
  const links = [`${LINKEDIN}/posts/ada-example_fixture-activity-7000000000000000001-AbCd`, POST];
  for (const postUrl of links) {
    assert.equal((await readPage(postUrl)).paths[0], "/api/v1/posts/7000000000000000001");
    const resumed = await readPage(postUrl, cursor);
    assert.deepEqual(resumed.names, ["Chidi Fixture", "Elif Placeholder"]);
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
    name: link.providerRef,
    single_use: true,
    disabled_options: ["cookie_auth"],
  });
  const status = { status: "connected", checkedAt: new Date(NOW) };
  assert.deepEqual(await linkedin.getAccountStatus(ACCOUNT), status);
});

test("parseWebhook wants the shared secret, compared in constant time: a wrong or missing one, and Unipile's notify without it, are linkedin_webhook_invalid", async () => {
  const status = fixture("webhook-account-status.json");
  const notify = fixture("webhook-notify.json");
  const signed = (rawBody: LinkedinWebhook["rawBody"], secret: unknown = SECRET) => ({
    headers: { "content-type": "application/json", [SECRET_HEADER]: secret as string },
    rawBody,
  });
  const credentials = { kind: "account.credentials_required", providerAccountRef: ACCOUNT };
  assert.deepEqual(await linkedin.parseWebhook(signed(status)), credentials);
  assert.deepEqual(await linkedin.parseWebhook(signed(new TextEncoder().encode(notify))), {
    kind: "account.connected",
    providerAccountRef: ACCOUNT,
    providerRef: "whytide-00000000-0000-4000-8000-000000000001",
  });
  const sync = status.replace("CREDENTIALS", "SYNC_SUCCESS");
  const refused = [
    signed(status, `${SECRET}0`),
    signed(status, SECRET.slice(1)),
    signed(status, [SECRET, SECRET]),
    { headers: {}, rawBody: status },
    { headers: { "content-type": "application/json" }, rawBody: notify },
    signed(sync),
    signed("not json"),
  ];
  for (const webhook of refused) {
    await assert.rejects(linkedin.parseWebhook(webhook), fails("linkedin_webhook_invalid"));
  }
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
      { type: "errors/disconnected_account" },
    ],
    [{ status: 404, file: "error.json" }, "linkedin_not_found", {}],
    [
      { status: 500, file: "error.json" },
      "linkedin_provider_error",
      { status: 500, type: "errors/unexpected_error" },
    ],
  ];
  for (const [answer, code, details] of cases) {
    failNext = answer;
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
  failNext = { status: 302, headers: { location }, file: "error.json" };
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
