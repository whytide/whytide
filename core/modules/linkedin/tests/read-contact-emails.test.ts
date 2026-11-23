// readContactEmails (gamma-en-087; README.md "Contact info"), in this file's schema of the worktree's
// database, each run as `app`, on the LinkedIn fake and a clock the test sets, with the worker's
// decrypt entry registered as the worker registers it (importing workflows/index.ts). The switch: off
// by default, `disabled` with no read reserved, no row and no call. On: the account the person
// accepted reads, the one with the most reads left among those, one `read_profile` reserved,
// committed and logged with the person's id, counted in its daily reads; only the emails, lower
// case. No accepted invitation, or its account not connected: `not_connected`, no call. The read
// cap, the window, a kill switch and a health pause: `no_reads_left`, no call. A failure after the
// call, committed and thrown; outside the worker; a person id of another form.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { tenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { loadMasterKeys, newMasterKey, servicePrincipal } from "@whytide/platform";
import { getAdapter, type LinkedinFake, linkedinPort } from "@whytide/providers";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import { type RefOpener, useRefOpener } from "../domain/company/read.ts";
import { readContactEmails } from "../domain/contact/read.ts";
import { contactInfoEnabled } from "../domain/contact/switch.ts";
import { reserveReads } from "../domain/quota/reservations.ts";
import type { WorkingHours } from "../domain/working-hours.ts";
import {
  createConnectedAccount,
  createOutreach,
  setAccountPaused,
  setHealth,
  useClock,
  useContactInfoEnabled,
  useLinkedinClient,
  useSecretKeys,
} from "../testing/index.ts";
import { withDecryptedRef } from "../workflows/decrypt.ts";
import "../workflows/index.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
useTenancyClient(app);
useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
const principal = servicePrincipal("linkedin_test");
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const START = new Date("2026-10-22T10:00:00Z"); // Thursday 12:00 in Paris
let at = START;
useClock(() => at);
afterEach(() => {
  useContactInfoEnabled(undefined);
  at = START;
});

const OFFICE: WorkingHours = { start: "08:30", end: "18:00", days: [1, 2, 3, 4, 5] };
const PERSON = "per_01JD0000000000000000000001";
const MEMBER = "fake-member-noor";
const SHOWN = ["Noor.Haddad@BlueHarbor.example", "noor.home@gmail.com"];
const EMAILS = ["noor.haddad@blueharbor.example", "noor.home@gmail.com"];
type Account = { id: string; ref: string };
/** The worker's decrypt entry, as workflows/index.ts registers it: put back after a test clears it. */
const entry: RefOpener = (context, id, fn) =>
  withDecryptedRef(
    { workspaceId: context.workspaceId, tenant: (run) => context.tenant(() => run(tenantClient)) },
    id,
    fn,
  );

/**
 * A workspace of its own with `count` connected accounts in Paris's office hours, each on the fake,
 * and the person invited by each one `accepted` names (by index), the member's ref on the row.
 */
async function workspaceWith(count: number, accepted: readonly number[] = []) {
  const [{ workspace }] = await createTwoWorkspaces();
  const workspaceId = workspace.id;
  const accounts: Account[] = [];
  for (let i = 0; i < count; i++) {
    const ref = `fake-account-${workspaceId}-${i}`;
    fake.emitWebhook("account.connected", ref);
    const settings = { timeZone: "Europe/Paris", workingHours: OFFICE, providerAccountRef: ref };
    const { id } = await createConnectedAccount(workspaceId, settings);
    accounts.push({ id, ref });
    // Every account invited the person; only those `accepted` names were accepted.
    await createOutreach(workspaceId, {
      senderAccountId: id,
      personId: PERSON,
      providerMemberRef: MEMBER,
      ...(accepted.includes(i) && { acceptedAt: new Date("2026-10-01T09:00:00Z") }),
    });
  }
  const tenant = <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app });
  const read = (personId = PERSON) => readContactEmails({ personId }, { workspaceId, tenant });
  /** `reads` profile reads, as signals' reads use the day. */
  const use = (accountId: string, reads: number) =>
    tenant(() => reserveReads({ accountId, count: reads, kind: "read_profile" }));
  return { workspaceId, accounts: accounts as [Account, ...Account[]], tenant, read, use };
}

const rows = async (workspaceId: string) =>
  (
    await app.senderActionLog.findMany({
      where: { workspaceId, kind: "read_profile", objectRef: PERSON },
      orderBy: { id: "asc" },
    })
  ).map(({ senderAccountId, outcome, count }) => [senderAccountId, outcome, count]);
const usage = async (senderAccountId: string) =>
  (await app.senderQuotaUsage.findMany({ where: { senderAccountId } })).map(
    ({ readsReserved, readsCommitted }) => [readsReserved, readsCommitted],
  );
const contactCalls = () => fake.recordedCalls.filter(({ method }) => method === "getContactEmails");

test("the switch is off by default: disabled, with no read reserved, no row, no quota day and no call", async () => {
  fake.reset();
  fake.seedContactEmails(MEMBER, SHOWN);
  assert.equal(contactInfoEnabled(), false, "LINKEDIN_CONTACT_INFO_ENABLED defaults to false");
  const { workspaceId, accounts, read } = await workspaceWith(1, [0]);
  assert.deepEqual(await read(), { status: "disabled" });
  // Off, it answers before any check: even outside the worker, even for an id of another form.
  useRefOpener(undefined);
  try {
    assert.deepEqual(await read("not-a-person"), { status: "disabled" });
  } finally {
    useRefOpener(entry);
  }
  assert.deepEqual(await rows(workspaceId), []);
  assert.equal(await app.senderActionLog.count({ where: { workspaceId } }), 0);
  assert.deepEqual(await usage(accounts[0].id), []);
  assert.equal(contactCalls().length, 0);
});

test("on: the account the person accepted reads, one read_profile reserved, committed and logged with the person's id, in its daily reads; only the emails, lower case", async () => {
  fake.reset();
  fake.seedContactEmails(MEMBER, SHOWN);
  useContactInfoEnabled(true);
  const { workspaceId, accounts, read } = await workspaceWith(2, [1]);
  const [invitedOnly, accepted] = accounts as [Account, Account];
  assert.deepEqual(await read(), { status: "read", emails: EMAILS });
  assert.deepEqual(
    contactCalls().map(({ input }) => input),
    [{ providerAccountRef: accepted.ref, memberRef: MEMBER }],
  );
  assert.deepEqual(await rows(workspaceId), [
    [accepted.id, "reserved", 1],
    [accepted.id, "ok", 1],
  ]);
  assert.deepEqual(await usage(accepted.id), [[0, 1]]);
  assert.deepEqual(await usage(invitedOnly.id), []);
  // No address in any row of the action log.
  const logged = JSON.stringify(await app.senderActionLog.findMany({ where: { workspaceId } }));
  for (const value of ["noor", "gmail", "blueharbor"]) assert.ok(!logged.includes(value), value);
});

test("two accounts the person accepted: the one with the most reads left reads; a member who shows none answers no address, its read counted", async () => {
  fake.reset();
  useContactInfoEnabled(true);
  const { accounts, read, use } = await workspaceWith(2, [0, 1]);
  const [busy, idle] = accounts as [Account, Account];
  await use(busy.id, 90);
  assert.deepEqual(await read(), { status: "read", emails: [] });
  assert.deepEqual(
    contactCalls().map(({ input }) => input),
    [{ providerAccountRef: idle.ref, memberRef: MEMBER }],
  );
  assert.deepEqual(await usage(idle.id), [[0, 1]]);
});

test("no accepted invitation, no member's ref, or its account no longer connected: not_connected, with no read reserved and no call", async () => {
  fake.reset();
  fake.seedContactEmails(MEMBER, SHOWN);
  useContactInfoEnabled(true);
  const invited = await workspaceWith(1);
  assert.deepEqual(await invited.read(), { status: "not_connected" });
  const stranger = await workspaceWith(1, [0]);
  assert.deepEqual(await stranger.read("per_01JD0000000000000000000002"), {
    status: "not_connected",
  });
  const noRef = await workspaceWith(1, [0]);
  await app.senderOutreach.updateMany({
    where: { workspaceId: noRef.workspaceId },
    data: { providerMemberRef: null },
  });
  assert.deepEqual(await noRef.read(), { status: "not_connected" });
  const gone = await workspaceWith(1, [0]);
  await app.senderAccount.update({
    where: { id: gone.accounts[0].id },
    data: { status: "disconnected" },
  });
  assert.deepEqual(await gone.read(), { status: "not_connected" });
  for (const { workspaceId } of [invited, stranger, noRef, gone]) {
    assert.equal(await app.senderActionLog.count({ where: { workspaceId } }), 0);
  }
  assert.equal(contactCalls().length, 0);
});

test("the read cap, the window, a kill switch and a health pause each answer no_reads_left with no call", async () => {
  fake.reset();
  fake.seedContactEmails(MEMBER, SHOWN);
  useContactInfoEnabled(true);
  const full = await workspaceWith(1, [0]);
  await full.use(full.accounts[0].id, 100);
  assert.deepEqual(await full.read(), { status: "no_reads_left" });

  const late = await workspaceWith(1, [0]);
  at = new Date("2026-10-22T17:00:00Z"); // Thursday 19:00 in Paris
  assert.deepEqual(await late.read(), { status: "no_reads_left" });
  at = new Date("2026-10-23T07:00:00Z"); // Friday 09:00
  assert.equal((await late.read()).status, "read");

  const [account] = late.accounts;
  await setAccountPaused(account.id, "tester");
  assert.deepEqual(await late.read(), { status: "no_reads_left" });
  await setAccountPaused(account.id, null);
  await setHealth(account.id, "restricted", { pausedUntil: new Date("2026-10-24T00:00:00Z") });
  assert.deepEqual(await late.read(), { status: "no_reads_left" });
  assert.equal(contactCalls().length, 1);
});

test("a provider error after the call is thrown, its read committed and logged; a failure before any call releases it", async () => {
  fake.reset();
  fake.seedContactEmails(MEMBER, SHOWN);
  useContactInfoEnabled(true);
  const { workspaceId, accounts, read } = await workspaceWith(1, [0]);
  const [only] = accounts;
  fake.failNext("linkedin_provider_error");
  await assert.rejects(read(), { code: "linkedin_provider_error" });
  assert.deepEqual(await usage(only.id), [[0, 1]]);
  // The reference cleared: the entry throws before any call, and the read is released.
  await app.senderAccount.update({ where: { id: only.id }, data: { providerAccountRef: null } });
  await assert.rejects(read(), { code: "linkedin_account_disconnected" });
  assert.deepEqual(await usage(only.id), [[0, 1]]);
  assert.deepEqual(await rows(workspaceId), [
    [only.id, "reserved", 1],
    [only.id, "linkedin_provider_error", 1],
    [only.id, "reserved", 1],
  ]);
});

test("on, a person id of another form is read_input_invalid, and outside the worker contact_read_unavailable; neither reserves", async () => {
  fake.reset();
  useContactInfoEnabled(true);
  const { workspaceId, read } = await workspaceWith(1, [0]);
  await assert.rejects(read("https://www.linkedin.com/in/noor"), { code: "read_input_invalid" });
  useRefOpener(undefined);
  try {
    await assert.rejects(read(), { code: "contact_read_unavailable" });
  } finally {
    useRefOpener(entry);
  }
  assert.equal(await app.senderActionLog.count({ where: { workspaceId } }), 0);
  assert.equal(contactCalls().length, 0);
});
