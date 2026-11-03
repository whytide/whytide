// Safety case, send path (beta-p0-060; core/modules/linkedin/docs/security.md "Personal
// conversations"): a LinkedIn message from a conversation Whytide did not start, through POST
// /v1/linkedin/webhooks/fake on the fake's signed event, answers 204 and leaves no trace: no receipt,
// no outreach change, no file, no outbox row, no log line with its refs or its text; the dropped
// events' counter rises by one, for message.received. A friend's message to a connected account, the
// account's own message to that friend, and a message to an account none of ours. The host started
// with linkedin on the fakes, in a schema of the worktree's database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, loadMasterKeys, newMasterKey } from "@whytide/platform";
import {
  filesConfig,
  filesPort,
  getAdapter,
  type LinkedinFake,
  type LinkedinWebhook,
  linkedinPort,
} from "@whytide/providers";
import { createOrganizationWithWorkspace, useTenancyClient } from "@whytide/tenancy/testing";
import { type Api, start } from "../../src/start.ts";

// linkedin by its build's path, as src/modules.generated.ts loads it (../linkedin-accounts.test.ts).
const build = new URL("../../../../../modules/linkedin/dist/", import.meta.url);
type LinkedinTesting = typeof import("../../../../modules/linkedin/dist/testing/index.js");
type LinkedinMetrics = typeof import("../../../../modules/linkedin/dist/metrics.js");
const testing: LinkedinTesting = await import(new URL("testing/index.js", build).href);
const { linkedinMetrics }: LinkedinMetrics = await import(new URL("metrics.js", build).href);
const { createConnectedAccount, createOutreach, useLinkedinClient, useSecretKeys } = testing;

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
useLinkedinClient(app);
useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const logs = collectLogs();
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: logs.destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "linkedin", load: () => import(new URL("index.js", build).href) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

async function post({ headers, rawBody }: LinkedinWebhook): Promise<number> {
  const url = new URL("/v1/linkedin/webhooks/fake", api.url);
  const init = { method: "POST", headers: headers as Record<string, string>, body: rawBody };
  const res = await fetch(url, init);
  await res.body?.cancel();
  return res.status;
}

/** What a kept message would have written: receipts, outreach rows, events and files. */
async function traces(workspaceId: string) {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  return {
    receipts: await app.linkedinEventReceipt.count(),
    outreach: await app.senderOutreach.findMany({ where: { workspaceId } }),
    events: await app.outboxEntry.count({ where: { workspaceId } }),
    files: (await files.list({ workspaceId, prefix: "raw/linkedin/" })).files,
  };
}

test("a message from a conversation Whytide did not start leaves no row, file, outbox row or log line, and counts one drop", async (t) => {
  const { workspace } = await createOrganizationWithWorkspace();
  const ref = `fake-account-${randomUUID()}`;
  const { id: senderAccountId } = await createConnectedAccount(workspace.id, {
    providerAccountRef: ref,
  });
  // Whytide invited Ines from this account, in a chat of its own; Hugo is a friend of the user's.
  const invited = { providerMemberRef: "member-ines", providerChatRef: "chat-ines" };
  await createOutreach(workspace.id, { senderAccountId, ...invited });
  const before = await traces(workspace.id);
  const friend = { memberRef: "member-hugo", chatRef: "chat-hugo" };
  const text = "Dinner on Friday? Bring the kids, and the recipe.";
  const webhooks = [
    fake.emitMessage(ref, { ...friend, text }),
    fake.emitMessage(ref, { ...friend, text, fromAccount: true }),
    fake.emitMessage(`fake-account-${randomUUID()}`, { ...friend, text }),
  ];
  const dropped = t.mock.method(linkedinMetrics["linkedin.events_dropped"], "add");
  for (const [i, webhook] of webhooks.entries()) {
    assert.equal(await post(webhook), 204);
    assert.equal(dropped.mock.callCount(), i + 1, "one drop per message");
  }
  const labels = dropped.mock.calls.map((call) => call.arguments);
  assert.deepEqual(
    labels,
    webhooks.map(() => [1, { kind: "message.received" }]),
  );
  assert.deepEqual(await traces(workspace.id), before);
  assert.deepEqual(before.files, []);

  const said = webhooks.map((webhook) => JSON.parse(String(webhook.rawBody)));
  const named = [text, friend.memberRef, friend.chatRef, ...said.flatMap((b) => [b.id, b.account])];
  const lines = logs.raw.join("\n");
  for (const value of named) assert.ok(!lines.includes(value), `no log line names ${value}`);
});
