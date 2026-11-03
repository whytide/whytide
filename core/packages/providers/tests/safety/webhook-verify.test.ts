// A safety case of beta-p0-020 (docs/architecture.md §13, "verify, answer at once, process later";
// linkedin/README.md "Events"): the port verifies a webhook before it reads its body. A forged event
// of every kind, its body signed under another secret, and the same body unsigned, are
// linkedin_webhook_invalid for the signature, and JSON.parse never runs on them: even a forged body
// that is not JSON is refused for its signature, never for its body. A signed event of a type the
// port does not know is `ignored`, a result and never an error, so the provider stops retrying it;
// it carries nothing of its body. The fake signs as its README says: under APP_ENV=test, which
// test:safety sets, with TEST_WEBHOOK_SECRET.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { beforeEach, test } from "node:test";
import { isAppError } from "@whytide/platform";
import { TEST_WEBHOOK_SECRET } from "../../linkedin/fake/constants.ts";
import { linkedinFake, SIGNATURE_HEADER } from "../../linkedin/fake/index.ts";
import {
  LINKEDIN_WEBHOOK_KINDS,
  type LinkedinWebhook,
  type LinkedinWebhookEvent,
  linkedinPort,
} from "../../linkedin/port.ts";
import { getAdapter } from "../../registry.ts";

const ACCOUNT = "fake-account-safety";
const MEMBER = "fake-member-safety";
const linkedin = await getAdapter(linkedinPort, "fake");

/** A body signed as the fake signs under APP_ENV=test. */
function signed(body: unknown): LinkedinWebhook {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const digest = createHmac("sha256", TEST_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return { headers: { [SIGNATURE_HEADER]: `sha256=${digest}` }, rawBody };
}

/** A signed event of each kind; for `ignored`, of a type the port does not know. */
const SIGNED: Readonly<Record<LinkedinWebhookEvent["kind"], () => LinkedinWebhook>> = {
  "account.connected": () => linkedinFake.emitWebhook("account.connected", ACCOUNT),
  "account.disconnected": () => linkedinFake.emitWebhook("account.disconnected", ACCOUNT),
  "account.credentials_required": () =>
    linkedinFake.emitWebhook("account.credentials_required", ACCOUNT),
  "account.status": () => linkedinFake.emitAccountStatus(ACCOUNT, "restricted"),
  "invite.accepted": () => linkedinFake.emitAccepted(ACCOUNT, MEMBER),
  "message.received": () =>
    linkedinFake.emitMessage(ACCOUNT, { memberRef: MEMBER, text: "Happy to talk next week" }),
  ignored: () => signed({ type: "message.reaction", account: ACCOUNT, reaction: "like" }),
};

/** linkedin_webhook_invalid for `reason`, its details nothing else. */
const refusedFor = (reason: "signature" | "body", label: string) => (error: unknown) => {
  assert.ok(
    isAppError(error) && error.code === "linkedin_webhook_invalid",
    `${label}: ${String(error)}`,
  );
  assert.deepEqual(error.details, { method: "parseWebhook", reason }, label);
  return true;
};

beforeEach(() => {
  linkedinFake.reset();
  linkedinFake.emitWebhook("account.connected", ACCOUNT);
});

test("a forged or unsigned event of every kind is linkedin_webhook_invalid for its signature, and its body is never parsed", async (t) => {
  for (const kind of LINKEDIN_WEBHOOK_KINDS) {
    const webhook = SIGNED[kind]();
    const parse = t.mock.method(JSON, "parse");
    assert.equal((await linkedin.parseWebhook(webhook)).kind, kind, `${kind}: signed, it parses`);
    assert.ok(parse.mock.callCount() > 0, `${kind}: the spy sees a signed body parsed`);
    const refused = {
      forged: linkedinFake.forge(webhook),
      unsigned: { headers: { "content-type": "application/json" }, rawBody: webhook.rawBody },
    };
    for (const [how, request] of Object.entries(refused)) {
      parse.mock.resetCalls();
      await assert.rejects(
        linkedin.parseWebhook(request),
        refusedFor("signature", `${kind} ${how}`),
      );
      assert.equal(parse.mock.callCount(), 0, `${kind} ${how}: JSON.parse never ran`);
    }
    parse.mock.restore();
  }
});

test("a forged body that is not JSON is refused for its signature, not for its body; signed, for its body", async () => {
  const notJson = signed("{ not json");
  await assert.rejects(
    linkedin.parseWebhook(linkedinFake.forge(notJson)),
    refusedFor("signature", "forged"),
  );
  await assert.rejects(linkedin.parseWebhook(notJson), refusedFor("body", "signed"));
});

test("a signed event of a type the port does not know is ignored, never an error, and carries nothing; unsigned or forged, linkedin_webhook_invalid", async () => {
  const unknown = [
    { type: "message.reaction", account: ACCOUNT, reaction: "like" },
    { type: "relation.removed", account: ACCOUNT, member: MEMBER },
    { type: "message.read", text: "Seen" },
  ];
  for (const body of unknown) {
    const webhook = signed(body);
    assert.deepEqual(await linkedin.parseWebhook(webhook), { kind: "ignored" }, body.type);
    const unsigned = { headers: {}, rawBody: webhook.rawBody };
    for (const [how, request] of Object.entries({
      unsigned,
      forged: linkedinFake.forge(webhook),
    })) {
      await assert.rejects(
        linkedin.parseWebhook(request),
        refusedFor("signature", `${body.type} ${how}`),
      );
    }
  }
});
