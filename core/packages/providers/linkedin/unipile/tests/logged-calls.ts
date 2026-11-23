// The log check's calls (mapping.test.ts, "the log check"), run in a child process of the test's so
// that every line written to its stdout or stderr, by a logger, console or a stream, reaches the
// check: a log call added to the adapter later is seen too. Each method runs against the test's
// fixture server as it succeeds, then the adapter fails through each error it maps, every fixture's
// included, and each error is logged as a caller logs it. The webhooks come from the fixtures, the
// notify's with its pairing token. The post reads page through their fixtures, a phrase's, a
// member's, a company's and the account's own, then fail too. The cursors handed out, the count of
// errors and the call metric's labels go to the test on file descriptor 3, never to stdout. No vendor
// is called.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { readdirSync, readFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createLogger, recordedMetrics } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { linkedinPort } from "../../port.ts";
import { SECRET_HEADER, unipileLinkedin } from "../index.ts";

const variable = (name: string) => process.env[name] ?? assert.fail(`${name} is not set`);
const baseUrl = variable("LOG_CHECK_BASE_URL");
const webhookSecret = variable("LOG_CHECK_SECRET");
const options = {
  apiKey: variable("LOG_CHECK_KEY"),
  webhookSecret,
  cursorSecret: variable("LOG_CHECK_CURSOR_SECRET"),
  notifyUrl: "https://api.whytide.test/v1/linkedin/webhooks/unipile",
  now: () => Date.parse("2026-10-02T12:00:00.000Z"),
};
/** A short timeout for the silent answer only, which nothing answers. */
const adapter = (baseUrl: string, timeoutMs?: number) =>
  bindPort(
    linkedinPort,
    unipileLinkedin({ ...options, baseUrl, ...(timeoutMs && { timeoutMs }) }),
    {
      adapter: "unipile",
    },
  );
const linkedin = adapter(baseUrl);
const logger = createLogger();
const account = { providerAccountRef: "fixture-account" };
const ada = { ...account, memberRef: "fixture-member-ada" };
const chidi = { ...account, memberRef: "fixture-member-chidi" };
const engagers = {
  ...account,
  postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/",
  limit: 2,
};
const cursors: string[] = [];
const kept = <Page extends { nextCursor: string | null }>(page: Page) => {
  if (page.nextCursor) cursors.push(page.nextCursor);
  return page.nextCursor ?? undefined;
};
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
/** A source's event from its fixture, with the Unipile-Auth header given. */
const webhook = (name: string, secret = webhookSecret) => ({
  headers: { [SECRET_HEADER]: secret },
  rawBody: fixture(name),
});
const SOURCES = [
  "webhook-message-received.json",
  "webhook-message-reaction.json",
  "webhook-new-relation.json",
  "webhook-status-credentials.json",
];
/** The notify of the fixtures' link, with its pairing token: no header (README.md "Pairing"). */
const token = createHmac("sha256", webhookSecret)
  .update("whytide-00000000-0000-4000-8000-000000000001")
  .digest("base64url");
const notify = {
  headers: {},
  rawBody: fixture("webhook-notify-token.json").replace("<token>", token),
};
const unsigned = (name: string) => ({ headers: {}, rawBody: fixture(name) });
/** The message fixture without its id: verified, and not Unipile's shape. */
const offShape = JSON.stringify({
  ...(JSON.parse(fixture("webhook-message-received.json")) as object),
  message_id: undefined,
});
const invite = () =>
  linkedin.sendInvite({ ...ada, note: "Hello Ada", idempotencyKey: "step-key-1" });
const message = () =>
  linkedin.sendMessage({ ...ada, text: "Hello Ada", idempotencyKey: "step-key-2" });
const since = { postedSince: new Date("2026-09-25T00:00:00.000Z"), limit: 1 };
const search = { ...account, ...since, phrase: "sales automation" };
const member = { ...account, ...since, authorUrl: "https://www.linkedin.com/in/ada-example" };
const company = { ...member, authorUrl: "https://www.linkedin.com/company/example-ltd" };
const own = { ...account, ...since };
const at = (cursor?: string) => (cursor ? { cursor } : {});
const postReads = [
  (cursor?: string) => linkedin.searchPosts({ ...search, ...at(cursor) }),
  (cursor?: string) => linkedin.listAuthorPosts({ ...member, ...at(cursor) }),
  (cursor?: string) => linkedin.listAuthorPosts({ ...company, ...at(cursor) }),
  (cursor?: string) => linkedin.listOwnPosts({ ...own, ...at(cursor) }),
];

// Every method as it succeeds.
await linkedin.createHostedAuthLink({
  successUrl: "https://app.whytide.test/w/acme/linkedin/connected",
  failureUrl: "https://app.whytide.test/w/acme/linkedin/failed",
  expiresInMin: 30,
});
await linkedin.getAccountStatus(account.providerAccountRef);
await linkedin.getProfile({ ...account, profileUrl: "https://www.linkedin.com/in/ada-example/" });
let cursor = kept(await linkedin.listPostEngagers(engagers));
while (cursor) cursor = kept(await linkedin.listPostEngagers({ ...engagers, cursor }));
for (const name of SOURCES) await linkedin.parseWebhook(webhook(name));
await linkedin.parseWebhook(notify);
await invite();
await linkedin.withdrawInvite({ ...account, invitationRef: "fixture-invitation-ada" });
cursor = kept(await linkedin.listPendingInvites(account));
while (cursor) cursor = kept(await linkedin.listPendingInvites({ ...account, cursor }));
await linkedin.getRelation(chidi);
await linkedin.sendMessage({
  ...chidi,
  chatRef: "fixture-chat-chidi",
  text: "Thanks",
  idempotencyKey: "step-key-3",
});
await message();
await linkedin.listRecentMessages({ ...chidi, since: new Date("2026-10-02T00:00:00.000Z") });
for (const read of postReads) {
  cursor = kept(await read());
  while (cursor) cursor = kept(await read(cursor));
}

// Then each failure, an answer queued at the test's server first where one is needed.
const spare = createServer().listen(0, "127.0.0.1");
await once(spare, "listening");
const closed = `http://127.0.0.1:${(spare.address() as AddressInfo).port}`;
spare.close();
const large = { status: 201, body: `{"padding":"${"x".repeat(1024 * 1024)}"}`, chunked: true };
type Failure = [answer: object | undefined, call: () => Promise<unknown>];
const failures: Failure[] = [
  ...readdirSync(join(import.meta.dirname, "fixtures"))
    .filter((name) => name.startsWith("error"))
    .flatMap((file): Failure[] => [
      [{ file }, invite],
      [{ file }, message],
    ]),
  [{ status: 404, file: "error.json" }, () => linkedin.getRelation(ada)],
  [{ status: 302, headers: { location: `${baseUrl}/api/v1/users/invite` } }, invite],
  [large, invite],
  [
    { silent: true },
    () => adapter(baseUrl, 200).sendInvite({ ...ada, idempotencyKey: "step-key-5" }),
  ],
  [{ status: 200, body: "not JSON" }, () => linkedin.listPendingInvites(account)],
  [undefined, () => linkedin.listPendingInvites({ ...account, cursor: "forged.cursor" })],
  [undefined, () => linkedin.listPostEngagers({ ...engagers, cursor: "forged.cursor" })],
  [undefined, () => linkedin.searchPosts({ ...search, cursor: "forged.cursor" })],
  [undefined, () => linkedin.listOwnPosts({ ...own, cursor: cursors[0] ?? "" })],
  [{ status: 401, file: "error-disconnected.json" }, () => linkedin.searchPosts(search)],
  [{ status: 404, file: "error.json" }, () => linkedin.listAuthorPosts(member)],
  [{ status: 500, file: "error.json" }, () => linkedin.listOwnPosts(own)],
  ...SOURCES.flatMap((name): Failure[] => [
    [undefined, () => linkedin.parseWebhook(webhook(name, "not the secret"))],
    [undefined, () => linkedin.parseWebhook(unsigned(name))],
  ]),
  [undefined, () => linkedin.parseWebhook(unsigned("webhook-notify-wrong-token.json"))],
  [
    undefined,
    () => linkedin.parseWebhook({ ...notify, rawBody: notify.rawBody.replace("SUCCESS", "FAIL") }),
  ],
  [undefined, () => linkedin.parseWebhook({ ...webhook(SOURCES[0] ?? ""), rawBody: offShape })],
  [undefined, () => linkedin.sendInvite({ ...ada, memberRef: "", idempotencyKey: "step-key-4" })],
  [undefined, () => adapter(closed).getAccountStatus(account.providerAccountRef)],
];
let errors = 0;
for (const [answer, call] of failures) {
  if (answer) {
    // The test's server takes the answer for the next request (mapping.test.ts, ANSWERS_PATH).
    await fetch(`${baseUrl}/__fixture/answers`, { method: "POST", body: JSON.stringify(answer) });
  }
  const failed = await call().then(
    () => assert.fail("the call was to fail"),
    (error: unknown) => error,
  );
  logger.error({ err: failed }, "linkedin call failed");
  errors += 1;
}
const labels = recordedMetrics().get("providers.calls") ?? [];
writeSync(3, JSON.stringify({ cursors, errors, labels }));
