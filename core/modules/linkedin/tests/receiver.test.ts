// The provider-event receiver (README.md "The webhook", docs/flows.md "The receiver"): the filter by
// member and by chat, a kept message's file and event, a redelivery after the file's deletion, a
// dropped event's counter, an acceptance once, the one transaction, the account warnings and their
// pause, a connected status without the link, lastInboundAt and the eraser, through handleWebhook on
// the LinkedIn and files fakes, against the worktree's database. The receipts' grants too, and the
// event key's keyed hash: none without the key.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { json } from "node:stream/consumers";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { withTenant } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { isAppError, loadMasterKeys, newMasterKey, servicePrincipal } from "@whytide/platform";
import { filesPort, getAdapter, type LinkedinFake, linkedinPort } from "@whytide/providers";
import { createOrganizationWithWorkspace, useTenancyClient } from "@whytide/tenancy/testing";
import { logAction } from "../domain/action-log/log.ts";
import { erasePerson } from "../domain/erase.ts";
import { type Outreach, pick } from "../domain/receiver/filter.ts";
import { lastInboundAt } from "../domain/receiver/last-inbound.ts";
import { handleWebhook } from "../domain/status.ts";
import { linkedinMetrics } from "../metrics.ts";
import { messageFile } from "../schemas/receiver.ts";
import {
  createConnectedAccount,
  createOutreach,
  useClock,
  useHashKey,
  useLinkedinClient,
  useSecretKeys,
} from "../testing/index.ts";
import { failingCommits, MEMBER, recorded, seeded } from "./fixtures/receiver.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
useTenancyClient(app);
useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
/** A test key, never a real one. */
const KEY = "linkedin-receiver-test-key-0123456789";
useHashKey(KEY);
/** The event key's keyed hash, as the receiver keeps it and names the message's file by. */
const hashOf = (id: string) => createHmac("sha256", KEY).update(`event:fake:${id}`).digest("hex");
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const files = await getAdapter(filesPort, "fake");
const principal = servicePrincipal("linkedin_test");
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app });
/** A webhook whose parseWebhook answer the test queued. */
const QUEUED = { headers: {}, rawBody: "{}" };
const bodyOf = (webhook: { rawBody: string | Uint8Array }) => JSON.parse(String(webhook.rawBody));

test("pick: an acceptance by its member; an inbound message by its sender, then its chat; the account's own by its chat, then its attendees", () => {
  const row = (id: string, member: string | null, chat: string | null): Outreach => ({
    id,
    personId: `per_${id}`,
    providerMemberRef: member,
    providerChatRef: chat,
  });
  const rows = [row("1", null, "chat-a"), row("2", "m-b", null), row("3", "m-c", "chat-c")];
  const base = { providerAccountRef: "acc", eventKey: "k" };
  const accepted = (memberRef: string) => ({
    ...base,
    kind: "invite.accepted" as const,
    memberRef,
  });
  const message = (chatRef: string, senderMemberRef: string, fromAccount: boolean) => ({
    ...base,
    kind: "message.received" as const,
    ...{ chatRef, messageRef: "k", senderMemberRef, fromAccount, sentAt: new Date(), text: "" },
    attendeeMemberRefs: fromAccount ? ["m-x", "m-c", "m-b"] : ["m-self"],
  });
  assert.equal(pick(accepted("m-b"), rows)?.id, "2");
  assert.equal(pick(accepted("m-x"), rows), null);
  assert.equal(pick(message("chat-a", "m-b", false), rows)?.id, "2");
  assert.equal(pick(message("chat-a", "m-x", false), rows)?.id, "1");
  assert.equal(pick(message("chat-a", "m-self", true), rows)?.id, "1");
  assert.equal(pick(message("chat-x", "m-self", true), rows)?.id, "3");
  assert.equal(pick(message("chat-x", "m-x", false), rows), null);
});

test("a message from an outreach row's member, or on its chat, is kept: its file, its receipt, linkedin.message_received with ids only; an inbound one sets last_inbound_at and the row's chat", async () => {
  const { workspaceId, ref, accountId, outreach } = await seeded();
  const own = await createOutreach(workspaceId, {
    senderAccountId: accountId,
    providerChatRef: "chat-tomas",
  });
  const text = "Tuesday works for me.";
  const inbound = fake.emitMessage(ref, { memberRef: MEMBER, chatRef: "chat-ines", text });
  const outbound = fake.emitMessage(ref, {
    ...{ memberRef: "member-tomas", chatRef: "chat-tomas" },
    ...{ text: "Thanks, Tomas.", fromAccount: true },
  });
  await handleWebhook("fake", inbound);
  await handleWebhook("fake", outbound);

  const keyOf = (webhook: typeof inbound) =>
    `w/${workspaceId}/raw/linkedin/messages/${hashOf(bodyOf(webhook).id)}.json`;
  const listed = await files.list({ workspaceId, prefix: "raw/linkedin/messages/" });
  const keys = [keyOf(inbound), keyOf(outbound)].sort();
  assert.deepEqual(listed.files.map((file) => file.key).sort(), keys);
  const stored = messageFile.parse(
    await json((await files.get({ workspaceId, key: keyOf(inbound) })).body),
  );
  const { id: messageRef, sender, attendees, sent_at: sentAt } = bodyOf(inbound);
  assert.deepEqual(stored, {
    ...{ chatRef: "chat-ines", messageRef, senderMemberRef: sender },
    ...{ attendeeMemberRefs: attendees, fromAccount: false, sentAt, text },
  });
  const events = await app.outboxEntry.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
  });
  const sent = { sender_account_id: accountId, event: "linkedin.message_received" };
  assert.deepEqual(
    events.map(({ eventName, payload }) => ({ event: eventName, ...(payload as object) })),
    [
      { ...sent, person_id: outreach.personId, direction: "in", file_key: keyOf(inbound) },
      { ...sent, person_id: own.personId, direction: "out", file_key: keyOf(outbound) },
    ],
  );
  const rows = await app.senderOutreach.findMany({ orderBy: { id: "asc" } });
  assert.deepEqual(
    rows.map((row) => [row.id, row.lastInboundAt?.toISOString() ?? null, row.providerChatRef]),
    [
      [outreach.id, sentAt, "chat-ines"],
      [own.id, null, "chat-tomas"],
    ],
  );
  assert.equal(await app.linkedinEventReceipt.count(), 2);
});

test("a message delivered again after its file was deleted writes no file: its receipt ends the delivery first", async () => {
  const { workspaceId, ref } = await seeded();
  const webhook = fake.emitMessage(ref, { memberRef: MEMBER, text: "Friday suits me better." });
  await handleWebhook("fake", webhook);
  // inbox's store deletes the file once the message is stored (beta-p5-010).
  const key = `raw/linkedin/messages/${hashOf(bodyOf(webhook).id)}.json`;
  await files.delete({ workspaceId, key });

  await handleWebhook("fake", webhook);

  assert.deepEqual((await files.list({ workspaceId, prefix: "" })).files, []);
  assert.deepEqual(await recorded(workspaceId), {
    receipts: 1,
    events: ["linkedin.message_received"],
  });
});

test("an event about no outreach row of its account is dropped and counted by kind, as is one the port ignores: nothing stored", async (t) => {
  const { workspaceId, ref } = await seeded();
  // Another account of the workspace invited Tomas: not a person of this account.
  const other = await createConnectedAccount(workspaceId);
  const tomas = { providerMemberRef: "member-tomas", providerChatRef: "chat-tomas" };
  await createOutreach(workspaceId, { senderAccountId: other.id, ...tomas });
  const dropped = t.mock.method(linkedinMetrics["linkedin.events_dropped"], "add");
  const message = { memberRef: "member-tomas", chatRef: "chat-tomas", text: "Hello again." };
  await handleWebhook("fake", fake.emitMessage(ref, message));
  await handleWebhook("fake", fake.emitAccepted(ref, "member-tomas"));
  fake.answerNext("parseWebhook", { kind: "ignored" });
  await handleWebhook("fake", QUEUED);
  assert.deepEqual(
    dropped.mock.calls.map((call) => call.arguments),
    ["message.received", "invite.accepted", "ignored"].map((kind) => [1, { kind }]),
  );
  assert.deepEqual(await recorded(workspaceId), { receipts: 0, events: [] });
  assert.deepEqual((await files.list({ workspaceId, prefix: "" })).files, []);
});

test("an acceptance sets accepted_at, the provider's time, and accepted_detected_at and publishes once; a later one publishes nothing; without a time, the detection's", async (t) => {
  const { workspaceId, ref, accountId, outreach } = await seeded();
  const detected = new Date("2026-10-29T09:30:00Z");
  useClock(() => detected);
  t.after(() => useClock(undefined));
  const first = fake.emitAccepted(ref, MEMBER);
  await handleWebhook("fake", first);
  await handleWebhook("fake", fake.emitAccepted(ref, MEMBER));
  const row = await app.senderOutreach.findUniqueOrThrow({ where: { id: outreach.id } });
  assert.deepEqual(
    [row.acceptedAt?.toISOString(), row.acceptedDetectedAt],
    [bodyOf(first).at, detected],
  );
  const events = await app.outboxEntry.findMany({ where: { workspaceId } });
  assert.deepEqual(
    events.map(({ eventName, payload }) => [eventName, payload]),
    [
      [
        "linkedin.invite_accepted",
        {
          sender_account_id: accountId,
          person_id: outreach.personId,
          detected_at: detected.toISOString(),
        },
      ],
    ],
  );
  assert.equal(await app.linkedinEventReceipt.count(), 2);

  const tomas = await createOutreach(workspaceId, {
    senderAccountId: accountId,
    providerMemberRef: "member-tomas",
  });
  const untimed = { providerAccountRef: ref, eventKey: "acceptance-1", memberRef: "member-tomas" };
  fake.answerNext("parseWebhook", { kind: "invite.accepted", ...untimed });
  await handleWebhook("fake", QUEUED);
  const accepted = await app.senderOutreach.findUniqueOrThrow({ where: { id: tomas.id } });
  assert.deepEqual([accepted.acceptedAt, accepted.acceptedDetectedAt], [detected, detected]);
});

test("an event kept while LINKEDIN_HASH_KEY is empty is linkedin_hash_key_missing, before any write: no file, receipt or event", async (t) => {
  const { workspaceId, ref } = await seeded();
  useHashKey(null);
  t.after(() => useHashKey(KEY));
  const missing = (error: unknown) =>
    isAppError(error) && error.code === "linkedin_hash_key_missing";
  const message = { memberRef: MEMBER, text: "Is Thursday good?" };
  await assert.rejects(handleWebhook("fake", fake.emitMessage(ref, message)), missing);
  await assert.rejects(handleWebhook("fake", fake.emitAccepted(ref, MEMBER)), missing);
  assert.deepEqual(await recorded(workspaceId), { receipts: 0, events: [] });
  assert.deepEqual((await files.list({ workspaceId, prefix: "" })).files, []);
});

test("an acceptance's receipt, its row's change and its event commit together: a commit that fails after the publish leaves none", async () => {
  const { workspaceId, ref, outreach } = await seeded();
  const webhook = fake.emitAccepted(ref, MEMBER);
  await failingCommits(() => assert.rejects(handleWebhook("fake", webhook), /the commit fails/));
  const row = await app.senderOutreach.findUniqueOrThrow({ where: { id: outreach.id } });
  assert.deepEqual([row.acceptedAt, row.acceptedDetectedAt], [null, null]);
  assert.deepEqual(await recorded(workspaceId), { receipts: 0, events: [] });
});

test("a checkpoint or restricted status counts linkedin.account_warnings by status and pauses the account, its health only (domain/health/): the session's status and reference stay; the checkpoint trips the fleet breaker once", async (t) => {
  const { workspaceId, ref, accountId } = await seeded();
  const before = await app.senderAccount.findUniqueOrThrow({ where: { id: accountId } });
  const warnings = t.mock.method(linkedinMetrics["linkedin.account_warnings"], "add");
  await handleWebhook("fake", fake.emitAccountStatus(ref, "checkpoint"));
  await handleWebhook("fake", fake.emitAccountStatus(ref, "restricted"));
  assert.deepEqual(
    warnings.mock.calls.map((call) => call.arguments),
    ["checkpoint", "restricted"].map((status) => [1, { status }]),
  );
  const after = await app.senderAccount.findUniqueOrThrow({ where: { id: accountId } });
  const { healthState, healthChangedAt, pausedUntil } = before;
  assert.deepEqual({ ...after, healthState, healthChangedAt, pausedUntil }, before);
  assert.equal(after.healthState, "checkpoint", "a restriction over a checkpoint extends it");
  assert.deepEqual(await recorded(workspaceId), {
    receipts: 0,
    events: ["linkedin.account_paused", "linkedin.invites_paused"],
  });
});

test("connected without the link's providerRef (Unipile's OK, SYNC_SUCCESS) is a status: a connected account keeps its reference and connected_at, one credentials_required is connected again and announced once, a pending one waits for its link's notify", async () => {
  const { workspaceId, ref, accountId } = await seeded();
  const account = () => app.senderAccount.findUniqueOrThrow({ where: { id: accountId } });
  const connectedAt = new Date("2026-10-01T09:00:00.000Z");
  await app.senderAccount.update({ where: { id: accountId }, data: { connectedAt } });
  const before = await account();
  await handleWebhook("fake", fake.emitWebhook("account.connected", ref));
  const after = await account();
  assert.notEqual(after.statusCheckedAt, null);
  assert.deepEqual({ ...after, statusCheckedAt: before.statusCheckedAt }, before);
  assert.deepEqual(await recorded(workspaceId), { receipts: 0, events: [] });

  await handleWebhook("fake", fake.emitWebhook("account.credentials_required", ref));
  await handleWebhook("fake", fake.emitAccountStatus(ref, "connected"));
  await handleWebhook("fake", fake.emitWebhook("account.connected", ref));
  const back = await account();
  assert.deepEqual(
    [back.status, back.connectedAt, back.providerAccountRef, back.healthState],
    ["connected", connectedAt, before.providerAccountRef, "healthy"],
  );
  // credentials_required is a lost session: the account paused (its health), then back.
  assert.deepEqual(await recorded(workspaceId), {
    receipts: 0,
    events: ["linkedin.account_paused", "linkedin.sender_account_connected"],
  });

  // The owner connects again: a status leaves the pending account; its link's notify pairs it.
  const link = { status: "pending" as const, providerLinkRef: `fake-link-${accountId}` };
  await app.senderAccount.update({ where: { id: accountId }, data: link });
  await handleWebhook("fake", fake.emitWebhook("account.connected", ref));
  assert.equal((await account()).status, "pending");
  const notify = { providerAccountRef: ref, providerRef: link.providerLinkRef };
  fake.answerNext("parseWebhook", { kind: "account.connected", ...notify });
  await handleWebhook("fake", QUEUED);
  const paired = await account();
  assert.deepEqual([paired.status, paired.providerLinkRef], ["connected", null]);
  assert.ok(paired.connectedAt !== null && paired.connectedAt > connectedAt);
  assert.deepEqual(await recorded(workspaceId), {
    receipts: 0,
    events: [
      "linkedin.account_paused",
      "linkedin.sender_account_connected",
      "linkedin.sender_account_connected",
    ],
  });
});

test("lastInboundAt: the latest inbound message's time, never an earlier one's; null for a person never heard from; the caller's workspace only", async () => {
  const { workspaceId, ref, accountId, outreach } = await seeded();
  const silent = await createOutreach(workspaceId, {
    senderAccountId: accountId,
    providerMemberRef: "member-tomas",
  });
  const earlier = fake.emitMessage(ref, { memberRef: MEMBER, text: "First." });
  await setTimeout(5);
  const later = fake.emitMessage(ref, { memberRef: MEMBER, text: "Second." });
  await handleWebhook("fake", later);
  await handleWebhook("fake", earlier);
  const read = (ws: string, personId: string) =>
    inRun(ws, () => lastInboundAt(accountId, personId));
  assert.equal((await read(workspaceId, outreach.personId))?.toISOString(), bodyOf(later).sent_at);
  assert.equal(await read(workspaceId, silent.personId), null);
  const { workspace: other } = await createOrganizationWithWorkspace();
  assert.equal(await read(other.id, outreach.personId), null);
  await assert.rejects(read(workspaceId, ""), { code: "read_input_invalid" });
});

test("erasePerson deletes the person's outreach rows and action-log rows in the caller's workspace, and nothing else", async () => {
  const { workspaceId, accountId, outreach } = await seeded();
  const { personId } = outreach;
  const second = await createConnectedAccount(workspaceId);
  await createOutreach(workspaceId, { senderAccountId: second.id, personId });
  const kept = await createOutreach(workspaceId, { senderAccountId: accountId });
  const { workspace: elsewhere } = await createOrganizationWithWorkspace();
  const away = await createConnectedAccount(elsewhere.id);
  await createOutreach(elsewhere.id, { senderAccountId: away.id, personId });
  const read = (id: string, objectRef: string) =>
    logAction({ accountId: id, kind: "read_profile", count: 1, outcome: "ok", objectRef });
  await inRun(workspaceId, () => read(accountId, personId));
  await inRun(workspaceId, () => read(accountId, kept.personId));
  await inRun(elsewhere.id, () => read(away.id, personId));

  const erased = await inRun(workspaceId, () => erasePerson(personId));
  assert.deepEqual(erased, { sender_outreach: 2, sender_action_log: 1 });
  const outreachOf = async (ref: string) =>
    (await app.senderOutreach.findMany({ where: { personId: ref } })).map((r) => r.workspaceId);
  const logOf = async (ref: string) =>
    (await app.senderActionLog.findMany({ where: { objectRef: ref } })).map((r) => r.workspaceId);
  assert.deepEqual(
    [await outreachOf(personId), await logOf(personId)],
    [[elsewhere.id], [elsewhere.id]],
  );
  assert.deepEqual(
    [await outreachOf(kept.personId), await logOf(kept.personId)],
    [[workspaceId], [workspaceId]],
  );
  await assert.rejects(
    inRun(workspaceId, () => erasePerson(" ")),
    { code: "read_input_invalid" },
  );
});

test("linkedin_event_receipts: app inserts, reads and deletes a receipt of a person event's kind, and never changes one", async () => {
  const receipt = {
    eventKeyHash: "0".repeat(64),
    kind: "message.received",
    receivedAt: new Date(),
  };
  await app.linkedinEventReceipt.create({ data: { id: "ler_1", ...receipt } });
  const update = `UPDATE "linkedin_event_receipts" SET "kind" = 'invite.accepted'`;
  assert.equal(await sqlstate(app.$executeRawUnsafe(update)), "42501");
  const insert = `INSERT INTO "linkedin_event_receipts" VALUES ('ler_2', 'k', 'account.status', now())`;
  assert.equal(await sqlstate(app.$executeRawUnsafe(insert)), "23514");
  assert.equal((await app.linkedinEventReceipt.deleteMany()).count, 1);
});
