// A safety case of beta-p0-040 (docs/architecture.md §13, "verify, answer at once, process later";
// linkedin/unipile/README.md "Webhooks", "Pairing"): Unipile's webhooks are verified before they are
// parsed. An event of each of the three sources with a wrong Unipile-Auth header is refused for its
// header, and one without the header for the pairing token it lacks; a hosted-auth notify with a
// wrong token, none, or another providerRef's or another secret's is refused for its token. Each is
// linkedin_webhook_invalid and JSON.parse never runs on it, so a notify's account id is never read
// unless its token verifies. And no account status is dropped (docs/07 §5.7, item 3): every one maps
// to an account event, an unknown one to account.disconnected, never `ignored` and never an error.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { isAppError } from "@whytide/platform";
import { bindPort } from "../../_pattern/index.ts";
import { type LinkedinWebhook, linkedinPort } from "../../linkedin/port.ts";
import { SECRET_HEADER, unipileLinkedin } from "../../linkedin/unipile/index.ts";

/** Made up for the run, so that no string in the repository looks like a secret. */
const SECRET = randomBytes(32).toString("hex");
const FIXTURES = join(import.meta.dirname, "..", "..", "linkedin", "unipile", "tests", "fixtures");
const ACCOUNT = "fixture-account";
/** The providerRef of the notify fixtures. */
const PAIRED = "whytide-00000000-0000-4000-8000-000000000001";
const linkedin = bindPort(
  linkedinPort,
  unipileLinkedin({
    baseUrl: "https://api.unipile.test",
    apiKey: randomBytes(24).toString("base64url"),
    webhookSecret: SECRET,
    cursorSecret: randomBytes(32).toString("hex"),
  }),
  { adapter: "unipile" },
);

const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
/** The pairing token of a providerRef: the HMAC-SHA-256 of it under the secret, in base64url. */
const tokenOf = (providerRef: string, secret = SECRET) =>
  createHmac("sha256", secret).update(providerRef).digest("base64url");
/** A notify as Unipile sends it: no header, the link's name in its body. */
const notify = (name: string): LinkedinWebhook => ({
  headers: { "content-type": "application/json" },
  rawBody: JSON.stringify({ status: "CREATION_SUCCESS", account_id: ACCOUNT, name }),
});
/** A body with the Unipile-Auth header given. */
const withHeader = (rawBody: string, secret: string | string[] = SECRET): LinkedinWebhook => ({
  headers: { "content-type": "application/json", [SECRET_HEADER]: secret },
  rawBody,
});

/** An event of each source, with the header, and the kind it parses to. */
const SOURCES: Readonly<Record<string, string>> = {
  "webhook-message-received.json": "message.received",
  "webhook-message-reaction.json": "ignored",
  "webhook-new-relation.json": "invite.accepted",
  "webhook-status-ok.json": "account.connected",
  "webhook-status-credentials.json": "account.credentials_required",
  "webhook-status-unknown.json": "account.disconnected",
};
/** Every status Unipile documents, as listed in README.md "Webhooks". */
const STATUSES: Readonly<Record<string, string>> = {
  OK: "account.connected",
  RECONNECTED: "account.connected",
  CREATION_SUCCESS: "account.connected",
  SYNC_SUCCESS: "account.connected",
  CREDENTIALS: "account.credentials_required",
  ERROR: "account.disconnected",
  STOPPED: "account.disconnected",
  DELETED: "account.disconnected",
  CONNECTING: "account.disconnected",
  CREATION_FAIL: "account.disconnected",
  PERMISSIONS: "account.disconnected",
};
/** Statuses Unipile does not send today, a new one, a case or a space off, or no string at all. */
const UNKNOWN: readonly unknown[] = [
  "A_STATUS_UNIPILE_ADDS_LATER",
  "ok",
  " OK",
  "SYNC_SUCCESS ",
  "CREDENTIAL",
  "",
  null,
  0,
  true,
  ["OK"],
  { status: "OK" },
  undefined,
];

/** linkedin_webhook_invalid for `reason`, its details nothing else. */
const refusedFor = (reason: "secret" | "token", label: string) => (error: unknown) => {
  assert.ok(
    isAppError(error) && error.code === "linkedin_webhook_invalid",
    `${label}: ${String(error)}`,
  );
  assert.deepEqual(error.details, { method: "parseWebhook", reason }, label);
  return true;
};

/** Refused for `reason`, and JSON.parse never ran on the request. */
async function refusedUnparsed(
  t: TestContext,
  request: LinkedinWebhook,
  reason: "secret" | "token",
  label: string,
) {
  const parse = t.mock.method(JSON, "parse");
  await assert.rejects(linkedin.parseWebhook(request), refusedFor(reason, label));
  assert.equal(parse.mock.callCount(), 0, `${label}: JSON.parse never ran`);
  parse.mock.restore();
}

test("an event of each source with a wrong Unipile-Auth header is refused for it, and one without the header for its missing token, before its body is parsed", async (t) => {
  for (const [name, kind] of Object.entries(SOURCES)) {
    const rawBody = fixture(name);
    const parse = t.mock.method(JSON, "parse");
    assert.equal((await linkedin.parseWebhook(withHeader(rawBody))).kind, kind, `${name}: signed`);
    assert.ok(parse.mock.callCount() > 0, `${name}: the spy sees a verified body parsed`);
    parse.mock.restore();
    const wrong = {
      "one character more": `${SECRET}0`,
      "one character less": SECRET.slice(1),
      "another secret": randomBytes(32).toString("hex"),
      "its case changed": SECRET.toUpperCase(),
      empty: "",
      twice: [SECRET, SECRET],
    };
    for (const [how, secret] of Object.entries(wrong)) {
      await refusedUnparsed(t, withHeader(rawBody, secret), "secret", `${name}, ${how}`);
    }
    const missing = {
      "no header": {},
      "another header": { "content-type": "application/json", "x-unipile-auth": SECRET },
      "an undefined header": { [SECRET_HEADER]: undefined },
    };
    for (const [how, headers] of Object.entries(missing)) {
      await refusedUnparsed(t, { headers, rawBody }, "token", `${name}, ${how}`);
      const bytes = { headers, rawBody: new TextEncoder().encode(rawBody) };
      await refusedUnparsed(t, bytes, "token", `${name} as bytes, ${how}`);
    }
  }
});

test("a notify with a wrong token, none, or another providerRef's or another secret's is refused for its token before its body is parsed; with its own token it pairs", async (t) => {
  const good = fixture("webhook-notify-token.json").replace("<token>", tokenOf(PAIRED));
  const parse = t.mock.method(JSON, "parse");
  const paired = { kind: "account.connected", providerAccountRef: ACCOUNT, providerRef: PAIRED };
  assert.deepEqual(await linkedin.parseWebhook({ headers: {}, rawBody: good }), paired);
  assert.ok(parse.mock.callCount() > 0, "the spy sees a paired notify parsed");
  parse.mock.restore();
  const other = "whytide-00000000-0000-4000-8000-000000000002";
  const refused: Readonly<Record<string, LinkedinWebhook>> = {
    "a wrong token": { headers: {}, rawBody: fixture("webhook-notify-wrong-token.json") },
    "no token": { headers: {}, rawBody: fixture("webhook-notify.json") },
    "another providerRef's token": notify(`${PAIRED}.${tokenOf(other)}`),
    "its token on another providerRef": notify(`${other}.${tokenOf(PAIRED)}`),
    "another secret's token": notify(
      `${PAIRED}.${tokenOf(PAIRED, randomBytes(32).toString("hex"))}`,
    ),
    "its token one character short": notify(`${PAIRED}.${tokenOf(PAIRED).slice(1)}`),
    "its token's case changed": notify(`${PAIRED}.${swapCase(tokenOf(PAIRED))}`),
    "two names, its own and another": {
      headers: {},
      rawBody: JSON.stringify({
        status: "CREATION_SUCCESS",
        account_id: ACCOUNT,
        name: `${other}.${tokenOf(PAIRED)}`,
        note: `${PAIRED}.${tokenOf(PAIRED)}`,
      }),
    },
    "a body that is not JSON": { headers: {}, rawBody: "{ not json" },
  };
  for (const [how, request] of Object.entries(refused)) {
    await refusedUnparsed(t, request, "token", how);
  }
});

test("every account status maps to an account event, an unknown one to account.disconnected: never ignored, never an error", async () => {
  const status = (message: unknown, account_type = "LINKEDIN") =>
    withHeader(JSON.stringify({ AccountStatus: { account_id: ACCOUNT, account_type, message } }));
  const expected = (kind: string) => ({ kind, providerAccountRef: ACCOUNT });
  for (const [message, kind] of Object.entries(STATUSES)) {
    assert.deepEqual(await linkedin.parseWebhook(status(message)), expected(kind), message);
  }
  for (const message of UNKNOWN) {
    const event = await linkedin.parseWebhook(status(message));
    assert.deepEqual(event, expected("account.disconnected"), JSON.stringify(message) ?? "none");
  }
  // Whatever the account's type: an account none of linkedin's matches nothing downstream.
  for (const type of ["WHATSAPP", "", "linkedin"]) {
    const event = await linkedin.parseWebhook(status("A_STATUS_UNIPILE_ADDS_LATER", type));
    assert.deepEqual(event, expected("account.disconnected"), type);
  }
});

/** A token with each letter's case swapped: another string of the same length. */
function swapCase(text: string): string {
  return [...text].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("");
}
