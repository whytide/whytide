// Safety case, send path (beta-p0-060; docs/flows.md "The receiver"): the receiver hands each
// provider event on once, and a reply's signal never without its event. One event delivered twice, a
// message or an acceptance, at once or one after the other, writes one receipt and publishes once;
// an inbound message's last_inbound_at, which campaigns' gate reads as a reply, commits with its
// outbox row or not at all. On the LinkedIn and files fakes, against the worktree's database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { loadMasterKeys, newMasterKey } from "@whytide/platform";
import { getAdapter, type LinkedinFake, linkedinPort } from "@whytide/providers";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { handleWebhook } from "../../domain/status.ts";
import { useHashKey, useLinkedinClient, useSecretKeys } from "../../testing/index.ts";
import { failingCommits, MEMBER, recorded, seeded } from "../fixtures/receiver.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
useTenancyClient(app);
useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
useHashKey("linkedin-receiver-once-test-key-0123456789"); // a test key, never a real one
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;

test("one event delivered twice, a message at once or an acceptance in turn, writes one receipt and publishes once", async () => {
  const { workspaceId, ref } = await seeded();
  const message = fake.emitMessage(ref, { memberRef: MEMBER, text: "Happy to talk next week." });
  await Promise.all([handleWebhook("fake", message), handleWebhook("fake", message)]);
  const accepted = fake.emitAccepted(ref, MEMBER);
  await handleWebhook("fake", accepted);
  await handleWebhook("fake", accepted);
  assert.deepEqual(await recorded(workspaceId), {
    receipts: 2,
    events: ["linkedin.invite_accepted", "linkedin.message_received"],
  });
});

test("an inbound message's last_inbound_at commits with its outbox row: a commit that fails after the publish leaves neither", async () => {
  const { workspaceId, ref, outreach } = await seeded();
  const webhook = fake.emitMessage(ref, { memberRef: MEMBER, text: "Yes, send me the deck." });
  const row = () => app.senderOutreach.findUniqueOrThrow({ where: { id: outreach.id } });
  await failingCommits(() => assert.rejects(handleWebhook("fake", webhook), /the commit fails/));
  assert.equal((await row()).lastInboundAt, null);
  assert.deepEqual(await recorded(workspaceId), { receipts: 0, events: [] });

  // The vendor's retry, once commits go through, records both.
  await handleWebhook("fake", webhook);
  const { sent_at } = JSON.parse(String(webhook.rawBody));
  assert.equal((await row()).lastInboundAt?.toISOString(), sent_at);
  assert.deepEqual(await recorded(workspaceId), {
    receipts: 1,
    events: ["linkedin.message_received"],
  });
});
