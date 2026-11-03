// The reference at rest and in the worker (acceptance criterion 2; docs/security.md): an account
// connected through the fake's hosted link, its webhook handled in-process, holds a sealed reference
// that a raw read cannot find in clear, that the worker's withDecryptedRef opens under the account's
// organization, and that fails under another organization's. And refreshStatus, the activity, stores
// what the provider says and publishes the disconnect; readPostEngagers, the engager read of a signal
// run (alpha-p8-020), writes each page to the files fake and answers no reference; readProfile, its
// twin (alpha-p8-030), reads the profile a request file names and writes it to a file, and answers a
// provider error as a refusal on its third attempt (fix-profile-skip).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { json } from "node:stream/consumers";
import { after, before, test } from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  isAppError,
  loadMasterKeys,
  newMasterKey,
  servicePrincipal,
  type TenantContext,
} from "@whytide/platform";
import {
  filesPort,
  getAdapter,
  type LinkedinFake,
  type LinkedinWebhook,
  linkedinPort,
} from "@whytide/providers";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import { startConnect } from "../domain/accounts.ts";
import { refHash } from "../domain/provider.ts";
import { handleWebhook } from "../domain/status.ts";
import { engagersFile } from "../schemas/engagers.ts";
import { profileFile } from "../schemas/profile.ts";
import { useLinkedinClient, useSecretKeys } from "../testing/index.ts";
import { withDecryptedRef } from "../workflows/decrypt.ts";
import { activities, readPostEngagers, readProfile, refreshStatus } from "../workflows/index.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
useTenancyClient(app);
useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
const principal = servicePrincipal("linkedin_test");
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const delivered: LinkedinWebhook[] = [];
const visits = createServer((req, res) =>
  fake.connectOnVisit(async (webhook) => {
    delivered.push(webhook);
    await handleWebhook("fake", webhook);
  })(req, res, () => void res.writeHead(404).end()),
);
let origin = "";

before(async () => {
  await new Promise<void>((done) => visits.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(visits.address() as AddressInfo).port}`;
});
after(() => visits.close());

/** A worker activity's context in the workspace, on the test schema, at its attempt. */
const contextOf = (workspaceId: string, attempt = 1) => ({
  workspaceId,
  attempt,
  tenant: <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app }),
});

/** Connect, follow the hosted link, and the fake's webhook pairs the account: its id and reference. */
async function connect(workspaceId: string): Promise<{ id: string; ref: string }> {
  const tenant: TenantContext = { workspaceId, principal };
  const returnTo = `${origin}/w/${workspaceId}/linkedin`;
  const input = { timeZone: "Europe/Paris", acknowledged: true, returnTo };
  const { url } = await startConnect(tenant, input);
  const visit = await fetch(url, { redirect: "manual" });
  assert.equal(visit.headers.get("location"), `${returnTo}?connect=done`);
  const { account: ref } = JSON.parse(String(delivered.at(-1)?.rawBody));
  const row = await app.senderAccount.findFirstOrThrow({ where: { workspaceId } });
  assert.equal(row.status, "connected");
  return { id: row.id, ref };
}

test("the reference is sealed at rest, opens in the worker under its organization, and not under another's", async () => {
  const [a, b] = await createTwoWorkspaces();
  const { id, ref } = await connect(a.workspace.id);
  const [raw] = await app.$queryRaw<{ ref: Uint8Array; hash: string }[]>`
    SELECT provider_account_ref AS ref, provider_account_ref_hash AS hash
    FROM sender_accounts WHERE id = ${id}`;
  assert.ok(raw && !Buffer.from(raw.ref).includes(ref), "the column does not hold the reference");
  assert.equal(raw.hash, refHash("fake", ref));
  const opened = await withDecryptedRef(contextOf(a.workspace.id), id, async (clear) => clear);
  assert.equal(opened, ref);

  // The same sealed bytes on an account of workspace B, whose organization is another.
  const other = await connect(b.workspace.id);
  await app.senderAccount.update({
    where: { id: other.id },
    data: { providerAccountRef: new Uint8Array(raw.ref) },
  });
  await assert.rejects(
    withDecryptedRef(contextOf(b.workspace.id), other.id, async (clear) => clear),
    (error) => isAppError(error) && error.code === "secret_context_mismatch",
  );
});

test("refreshStatus stores the provider's status and publishes the disconnect once", async () => {
  const [a] = await createTwoWorkspaces();
  const { id, ref } = await connect(a.workspace.id);
  const context = contextOf(a.workspace.id);
  assert.deepEqual(await refreshStatus(context, id), { status: "connected" });
  fake.emitWebhook("account.disconnected", ref); // the vendor's side, its webhook lost
  assert.deepEqual(await refreshStatus(context, id), { status: "disconnected" });
  assert.deepEqual(await refreshStatus(context, id), { status: "disconnected" });
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id } });
  assert.equal(row.status, "disconnected");
  const published = await app.outboxEntry.findMany({
    where: { workspaceId: a.workspace.id, eventName: "linkedin.sender_account_disconnected" },
  });
  assert.deepEqual(
    published.map((entry) => entry.payload),
    [{ sender_account_id: id }],
  );
});

test("readPostEngagers writes each page under raw/, answering its key, count and next cursor, and logs the read; a post out of sight and an account not connected are refusals", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const { id, ref } = await connect(workspaceId);
  const post = "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000001";
  fake.seedPost(
    post,
    [1, 2, 3].map((n) => ({
      providerMemberRef: `member-${n}`,
      profileUrl: `https://www.linkedin.com/in/member-${n}`,
      name: `Member ${n}`,
      headline: "Founder",
      reaction: "like" as const,
      engagedAt: new Date(Date.UTC(2026, 9, 20 + n)),
    })),
  );
  const context = contextOf(workspaceId);
  const input = { workspaceId, accountId: id, postUrl: post, limit: 2, rawKey: "raw/t/1.json" };
  const first = await readPostEngagers(context, input);
  assert.ok("key" in first && first.nextCursor !== null);
  assert.deepEqual(first, {
    key: `w/${workspaceId}/raw/t/1.json`,
    count: 2,
    nextCursor: first.nextCursor,
  });
  const files = await getAdapter(filesPort, "fake");
  const stored = engagersFile.parse(
    await json((await files.get({ workspaceId, key: first.key })).body),
  );
  assert.deepEqual(
    stored.engagers.map((engager) => [engager.providerMemberRef, engager.engagedAt]),
    [
      ["member-3", "2026-10-23T00:00:00.000Z"],
      ["member-2", "2026-10-22T00:00:00.000Z"],
    ],
  );
  const rest = { ...input, cursor: first.nextCursor, rawKey: "raw/t/2.json" };
  assert.deepEqual(await readPostEngagers(context, rest), {
    key: `w/${workspaceId}/raw/t/2.json`,
    count: 1,
    nextCursor: null,
  });
  const unseen = { ...input, postUrl: post.replace(/1$/, "2") };
  assert.deepEqual(await readPostEngagers(context, unseen), { refused: "linkedin_not_found" });
  fake.emitWebhook("account.disconnected", ref);
  const disconnected = { refused: "linkedin_account_disconnected" };
  assert.deepEqual(await readPostEngagers(context, input), disconnected);
  const reads = await app.senderActionLog.findMany({
    where: { senderAccountId: id, kind: "read_engagers" },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(
    reads.map((row) => [row.outcome, row.count, row.objectRef]),
    [
      ["ok", 1, post],
      ["ok", 1, post],
      ["linkedin_not_found", 1, unseen.postUrl],
      ["linkedin_account_disconnected", 1, post],
    ],
  );
  const outside = { ...input, rawKey: "exports/t/1.json" };
  assert.equal(activities.linkedin_read_post_engagers.input.safeParse(outside).success, false);
});

test("readProfile reads the profile its request file names and writes it under raw/, answering its key, and logs the read with no object; a profile out of sight and an account not connected are refusals", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const { id, ref } = await connect(workspaceId);
  const profileUrl = "https://www.linkedin.com/in/member-7";
  const seeded = {
    providerMemberRef: "member-7",
    profileUrl,
    firstName: "Member",
    lastName: "Seven",
    headline: "Head of sales at Example",
    title: "Head of sales",
    companyName: "Example",
    locationText: "Berlin, Germany",
  };
  fake.seedProfile(seeded);
  const files = await getAdapter(filesPort, "fake");
  const request = (key: string, url: string) =>
    files.put({
      workspaceId,
      key,
      body: JSON.stringify({ profileUrl: url }),
      contentType: "application/json",
    });
  await request("raw/p/1.request.json", profileUrl);
  await request("raw/p/2.request.json", `${profileUrl}0`);
  const context = contextOf(workspaceId);
  const input = {
    workspaceId,
    accountId: id,
    requestKey: "raw/p/1.request.json",
    rawKey: "raw/p/1.json",
  };
  assert.deepEqual(await readProfile(context, input), { key: `w/${workspaceId}/raw/p/1.json` });
  const stored = profileFile.parse(
    await json((await files.get({ workspaceId, key: "raw/p/1.json" })).body),
  );
  assert.deepEqual({ ...stored, fetchedAt: undefined }, { ...seeded, fetchedAt: undefined });
  const unseen = { ...input, requestKey: "raw/p/2.request.json", rawKey: "raw/p/2.json" };
  assert.deepEqual(await readProfile(context, unseen), { refused: "linkedin_not_found" });
  fake.emitWebhook("account.disconnected", ref);
  assert.deepEqual(await readProfile(context, input), { refused: "linkedin_account_disconnected" });
  const reads = await app.senderActionLog.findMany({
    where: { senderAccountId: id, kind: "read_profile" },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(
    reads.map((row) => [row.outcome, row.count, row.objectRef]),
    [
      ["ok", 1, null],
      ["linkedin_not_found", 1, null],
      ["linkedin_account_disconnected", 1, null],
    ],
  );
  const outside = { ...input, requestKey: "imports/p/1.request.json" };
  assert.equal(activities.linkedin_read_profile.input.safeParse(outside).success, false);
});

test("readProfile: a provider error fails attempts 1 and 2 and is the refusal linkedin_provider_error on attempt 3; a rate limit still fails it; a profile gone is a refusal on attempt 1", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const { id } = await connect(workspaceId);
  const files = await getAdapter(filesPort, "fake");
  const body = JSON.stringify({ profileUrl: "https://www.linkedin.com/in/member-8" });
  const file = { workspaceId, key: "raw/p/8.request.json", body, contentType: "application/json" };
  await files.put(file);
  const input = { workspaceId, accountId: id, requestKey: file.key, rawKey: "raw/p/8.json" };
  const { linkedin_provider_error, linkedin_rate_limited } = linkedinPort.errors;
  const failing = (
    code: typeof linkedin_provider_error | typeof linkedin_rate_limited,
    attempt: number,
  ) => {
    fake.failNext(code, { method: "getProfile" });
    return readProfile(contextOf(workspaceId, attempt), input);
  };
  const thrown = (code: string) => (error: unknown) => isAppError(error) && error.code === code;
  for (const attempt of [1, 2]) {
    await assert.rejects(
      failing(linkedin_provider_error, attempt),
      thrown(linkedin_provider_error),
    );
  }
  assert.deepEqual(await failing(linkedin_provider_error, 3), { refused: linkedin_provider_error });
  await assert.rejects(failing(linkedin_rate_limited, 3), thrown(linkedin_rate_limited));
  // Never seeded: gone, a refusal at once.
  const gone = await readProfile(contextOf(workspaceId, 1), input);
  assert.deepEqual(gone, { refused: "linkedin_not_found" });
});
