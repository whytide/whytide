// The safety cases of the risk disclosure for sending (beta-p1-070; docs/security.md "Personal
// accounts and the disclosure first"), run by `pnpm -F @whytide/linkedin test:safety`: alpha's
// version 1, a version 2 without the personal-account confirmation and a member id not known refuse
// every send, logged, while reads reserve; the owner's acceptance, and only theirs, lets the send
// through, and a refused one stores nothing; the refresh stores the member id's keyed hash, never
// the id, after which the send passes; a reconnect is refused member_id_unknown, by the reservation
// and by the send activity's gate, until the refresh reads the member id again; a refresh that reads
// another member id replaces the account, which is refused until its owner accepts again, its
// pending invitations unknown again (beta-p4-070); and one LinkedIn account sits on one connected
// row. remainingToday answers nothing while a send would be refused disclosure_required or
// member_id_unknown; without LINKEDIN_HASH_KEY a stored hash counts for nothing; and a refresh whose
// provider call outlasts a reconnect writes no member id.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  isAppError,
  loadMasterKeys,
  newMasterKey,
  servicePrincipal,
  type TenantContext,
} from "@whytide/platform";
import { getAdapter, type LinkedinFake, linkedinPort } from "@whytide/providers";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import { disconnect, findAccount, startConnect } from "../../domain/accounts.ts";
import { DISCLOSURE_VERSION } from "../../domain/disclosure/constants.ts";
import { acceptDisclosure } from "../../domain/disclosure/disclosure.ts";
import { remainingToday } from "../../domain/quota/reservations.ts";
import { sendStateRefusal } from "../../domain/send/state.ts";
import { completeConnect } from "../../domain/status.ts";
import {
  createConnectedAccount,
  useClock,
  useHashKey,
  useLinkedinClient,
  useRandom,
  useSecretKeys,
} from "../../testing/index.ts";
import { refreshStatus } from "../../workflows/index.ts";
import { ALWAYS, granted, sender, THURSDAY } from "../fixtures/send.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
useTenancyClient(app);
useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
let today = THURSDAY;
useClock(() => today);
useRandom(() => 0.999);
/** A test key, never a real one. */
const KEY = "linkedin-disclosure-test-key-0123456789";
useHashKey(KEY);
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const principal = servicePrincipal("linkedin_test");
const ACCEPTED = { version: DISCLOSURE_VERSION, personalAccount: true };

type Sender = Awaited<ReturnType<typeof sender>>;

/** Each send type's answer and a read's, `[code, retryAt]` or `["granted", null]`. */
async function refusals(account: Sender, key: string) {
  const answers = [
    await account.send(`${key}-invite`, "invite"),
    await account.send(`${key}-message`, "message"),
    await account.send(`${key}-withdraw`, "withdraw"),
    await account.read(),
  ];
  return answers.map((answer) =>
    "refused" in answer ? [answer.refused, answer.retryAt] : ["granted", null],
  );
}

const row = (id: string) => app.senderAccount.findUniqueOrThrow({ where: { id } });
const failsWith = (code: string) => (error: unknown) => isAppError(error) && error.code === code;
/** The worker's refresh of the account, in its workspace's run on the test schema. */
function refresh(account: Sender, before?: (run: number) => Promise<void>) {
  const { workspaceId } = account;
  let runs = 0;
  const tenant = async <T>(fn: (tx: TenantClient) => Promise<T>) => {
    runs += 1;
    await before?.(runs);
    return withTenant({ workspaceId, principal }, fn, { client: app });
  };
  return refreshStatus({ workspaceId, tenant }, account.id);
}
const RETURN_TO = "https://app.whytide.test/linkedin";
const CONNECT = { timeZone: "UTC", acknowledged: true, disclosureVersion: DISCLOSURE_VERSION };
/** The owner's disconnect and Connect, and the vendor's pairing of the row with the LinkedIn account `ref`. */
async function reconnect(account: Sender, ref: string) {
  const { ownerUserId: userId } = await row(account.id);
  const owner = { userId, actorType: "human", authMethod: "session", scopes: [] } as const;
  const tenant: TenantContext = { workspaceId: account.workspaceId, principal: owner };
  await account.run(() => disconnect(account.id));
  const input = { ...CONNECT, personalAccount: true, returnTo: RETURN_TO };
  const { url } = await startConnect(tenant, input);
  fake.emitWebhook("account.connected", ref);
  const providerRef = new URL(url).searchParams.get("link") ?? "";
  await completeConnect({ providerAccountRef: ref, providerRef });
}
const NOTHING = { invites: 0, messages: 0, withdrawals: 0, actions: 0, windowEnd: null };
/** An account of a tenancy workspace whose reference the fake knows connected, with its member id. */
async function referenced(workspaceId: string, memberRef: string | null) {
  const ref = `fake-account-${randomUUID()}`;
  fake.emitWebhook("account.connected", ref); // the vendor's side only
  const { memberRef: own } = await fake.getAccountStatus(ref);
  const account = await sender("UTC", ALWAYS, { workspaceId, providerAccountRef: ref, memberRef });
  return { ...account, ref, own: own ?? "" };
}

test("version 1, version 2 without the personal-account confirmation, and no member id refuse every send, disclosure_required, disclosure_required and member_id_unknown, with no time and logged; reads still reserve", async () => {
  const cases = [
    { settings: { disclosureVersion: 1 }, code: "disclosure_required" },
    { settings: { personalAccount: false }, code: "disclosure_required" },
    { settings: { memberRef: null }, code: "member_id_unknown" },
  ];
  for (const { settings, code } of cases) {
    const account = await sender("UTC", ALWAYS, settings);
    const refused = [code, null];
    const answers = await refusals(account, code);
    assert.deepEqual(answers, [refused, refused, refused, ["granted", null]], code);
    const logged = await app.senderActionLog.findMany({
      where: { senderAccountId: account.id, outcome: code },
    });
    assert.equal(logged.length, 3, `one log row for each refused send: ${code}`);
  }
});

test("only the owner accepts: another member, version 1 or 3, and personalAccount false are refused and store nothing; the owner's acceptance records the version, the time and the confirmation, the next send reserves, and a repeat changes nothing", async () => {
  const account = await sender("UTC", ALWAYS, { disclosureVersion: 1, personalAccount: false });
  const { ownerUserId, disclosureAcknowledgedAt } = await row(account.id);
  const accept = (userId: string, input: { version: number; personalAccount: boolean }) =>
    account.run(() => acceptDisclosure(account.id, userId, input));
  const stored = async () => {
    const after = await row(account.id);
    return [
      after.disclosureVersion,
      after.disclosureAcknowledgedAt,
      after.personalAccountConfirmedAt,
    ];
  };
  const before = [1, disclosureAcknowledgedAt, null];
  await assert.rejects(accept("usr_another_member", ACCEPTED), failsWith("not_account_owner"));
  for (const version of [1, 3]) {
    const invalid = { version, personalAccount: true };
    await assert.rejects(accept(ownerUserId, invalid), failsWith("disclosure_version_invalid"));
  }
  const notPersonal = { version: DISCLOSURE_VERSION, personalAccount: false };
  await assert.rejects(accept(ownerUserId, notPersonal), failsWith("personal_account_required"));
  assert.deepEqual(await stored(), before, "a refusal stores nothing");
  assert.deepEqual((await refusals(account, "before"))[0], ["disclosure_required", null]);

  const accepted = await accept(ownerUserId, ACCEPTED);
  assert.equal(accepted.disclosureVersion, DISCLOSURE_VERSION);
  assert.deepEqual(await stored(), [DISCLOSURE_VERSION, THURSDAY, THURSDAY]);
  granted(await account.send("accepted"));
  today = new Date(THURSDAY.getTime() + 60_000);
  try {
    assert.deepEqual(await accept(ownerUserId, ACCEPTED), accepted, "a repeat answers the same");
  } finally {
    today = THURSDAY;
  }
  assert.deepEqual(await stored(), [DISCLOSURE_VERSION, THURSDAY, THURSDAY]);
});

test("a connected account with no member id is refused member_id_unknown; once the refresh stores the member id's keyed hash, never the id, the send reserves", async () => {
  const [a] = await createTwoWorkspaces();
  const account = await referenced(a.workspace.id, null);
  assert.deepEqual((await refusals(account, "unknown"))[1], ["member_id_unknown", null]);
  assert.deepEqual(await refresh(account), { status: "connected" });
  const expected = createHmac("sha256", KEY).update(`linkedin:${account.own}`).digest("hex");
  assert.equal((await row(account.id)).memberIdHash, expected);
  granted(await account.send("known", "message"));
  const raw = await app.$queryRaw<{ line: string }[]>`
    SELECT row_to_json(t)::text AS line FROM sender_accounts t`;
  assert.ok(raw.length > 0 && raw.every(({ line }) => !line.includes(account.own)), "no id kept");
});

test("a reconnect is refused member_id_unknown, by the reservation and by the gate before the port call, until its refresh reads the member id: the same LinkedIn account then sends with its targets, another one is replaced", async () => {
  const [a] = await createTwoWorkspaces();
  const account = await referenced(a.workspace.id, null);
  await refresh(account);
  const targets = { inviteTarget: 12, messageTarget: 30 };
  await app.senderAccount.update({ where: { id: account.id }, data: targets });
  granted(await account.send("before"));
  const unknown = ["member_id_unknown", null];
  const gate = () =>
    account.run(async () => sendStateRefusal(await findAccount(account.id), "message", THURSDAY));

  await reconnect(account, account.ref);
  assert.deepEqual(await refusals(account, "same"), [unknown, unknown, unknown, ["granted", null]]);
  assert.deepEqual(await gate(), { refused: "member_id_unknown", retryAt: null });
  assert.deepEqual(await refresh(account), { status: "connected" });
  granted(await account.send("same-after"));
  const same = await row(account.id);
  assert.deepEqual([same.inviteTarget, same.messageTarget], [12, 30]);

  await reconnect(account, `fake-account-${randomUUID()}`); // another LinkedIn account on the row
  assert.deepEqual((await refusals(account, "other"))[0], unknown);
  assert.deepEqual(await gate(), { refused: "member_id_unknown", retryAt: null });
  await refresh(account);
  const replaced = await row(account.id);
  const reset = [replaced.inviteTarget, replaced.messageTarget, replaced.disclosureVersion];
  assert.deepEqual(reset, [5, 10, 1], "the targets and the disclosure start over");
  assert.deepEqual(await gate(), { refused: "disclosure_required", retryAt: null });
});

test("a refresh that reads another member id replaces the account: the targets back to 5 and 10, the disclosure to accept, linkedin.account_replaced once; it is refused disclosure_required until its owner accepts again; the same member id again changes nothing", async () => {
  const [a] = await createTwoWorkspaces();
  const account = await referenced(a.workspace.id, "member-before-the-replacement");
  const targets = { inviteTarget: 12, messageTarget: 30, rampUpdatedOn: "2026-10-21" };
  await app.senderAccount.update({ where: { id: account.id }, data: targets });
  granted(await account.send("before"));

  assert.deepEqual(await refresh(account), { status: "connected" });
  assert.deepEqual(await refresh(account), { status: "connected" }, "the same id again");
  const after = await row(account.id);
  assert.deepEqual([after.inviteTarget, after.messageTarget, after.rampUpdatedOn], [5, 10, null]);
  assert.deepEqual([after.disclosureVersion, after.personalAccountConfirmedAt], [1, null]);
  assert.deepEqual([after.pendingInvites, after.pendingInvitesCheckedAt], [null, null]);
  const replaced = await app.outboxEntry.findMany({
    where: { workspaceId: a.workspace.id, eventName: "linkedin.account_replaced" },
  });
  assert.deepEqual(
    replaced.map((entry) => entry.payload),
    [{ sender_account_id: account.id }],
  );
  const refused = ["disclosure_required", null];
  assert.deepEqual(await refusals(account, "replaced"), [
    refused,
    refused,
    refused,
    ["granted", null],
  ]);

  await account.run(() => acceptDisclosure(account.id, after.ownerUserId, ACCEPTED));
  const [invite] = await refusals(account, "accepted-again");
  assert.equal(invite?.[0], "pending_invites_unknown", "no invite before the next check");
  granted(await account.send("accepted-again-message", "message"));
});

test("one LinkedIn account on one connected row: the index refuses a second connected row with the same member id's hash in another workspace; a disconnected row keeps its hash", async () => {
  const first = await createConnectedAccount(`wsp_test${randomUUID().slice(0, 8)}`, {
    memberRef: "member-on-two-rows",
  });
  const second = () =>
    createConnectedAccount(`wsp_test${randomUUID().slice(0, 8)}`, {
      memberRef: "member-on-two-rows",
    });
  await assert.rejects(second(), {
    code: "P2002",
    message: /sender_accounts_member_id_hash_connected/,
  });
  await app.senderAccount.update({ where: { id: first.id }, data: { status: "disconnected" } });
  await second();
  assert.notEqual((await row(first.id)).memberIdHash, null);
});

test("remainingToday answers nothing, windowEnd null, while every send would be refused disclosure_required or member_id_unknown, so the plan places none", async () => {
  const cases = [{ disclosureVersion: 1 }, { personalAccount: false }, { memberRef: null }];
  for (const settings of cases) {
    const account = await sender("UTC", ALWAYS, settings);
    const left = await account.run(() => remainingToday(account.id));
    assert.deepEqual(left, NOTHING, JSON.stringify(settings));
  }
  const ready = await sender("UTC", ALWAYS, { memberRef: "member-ready" });
  assert.notEqual((await ready.run(() => remainingToday(ready.id))).windowEnd, null);
});

test("without LINKEDIN_HASH_KEY a stored member id's hash counts for nothing: every send is refused member_id_unknown, by the reservation and by the gate, and remainingToday answers nothing; reads reserve; the key back, the send passes", async (t) => {
  const account = await sender("UTC", ALWAYS, { memberRef: "member-before-the-key-went" });
  useHashKey(null);
  t.after(() => useHashKey(KEY));
  const unknown = ["member_id_unknown", null];
  assert.deepEqual(await refusals(account, "no-key"), [
    unknown,
    unknown,
    unknown,
    ["granted", null],
  ]);
  const gate = account.run(async () =>
    sendStateRefusal(await findAccount(account.id), "message", THURSDAY),
  );
  assert.deepEqual(await gate, { refused: "member_id_unknown", retryAt: null });
  assert.deepEqual(await account.run(() => remainingToday(account.id)), NOTHING);
  useHashKey(KEY);
  granted(await account.send("key-back", "message"));
});

test("a refresh whose provider call outlasts a disconnect and a reconnect writes no member id: the row stays member_id_unknown, then the next refresh reads the new pairing's", async () => {
  const [a] = await createTwoWorkspaces();
  const account = await referenced(a.workspace.id, null);
  await refresh(account);
  granted(await account.send("before", "message"));
  const other = `fake-account-${randomUUID()}`;
  // The refresh's runs: its row, the reference, then the status's, which the reconnect precedes.
  const stale = await refresh(account, (run) =>
    run === 3 ? reconnect(account, other) : Promise.resolve(),
  );
  assert.deepEqual(stale, { status: "connected" });
  const paired = await row(account.id);
  assert.equal(paired.memberIdCheckedAt, null, "no member id read for the new pairing");
  const unknown = ["member_id_unknown", null];
  assert.deepEqual((await refusals(account, "stale"))[1], unknown);

  await refresh(account);
  const read = await row(account.id);
  const { memberRef: own } = await fake.getAccountStatus(other);
  const expected = createHmac("sha256", KEY).update(`linkedin:${own}`).digest("hex");
  assert.deepEqual([read.memberIdHash, read.disclosureVersion], [expected, 1], "replaced");
});
