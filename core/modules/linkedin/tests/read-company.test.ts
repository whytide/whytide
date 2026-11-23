// readCompany (gamma-en-060; README.md "Company pages"), in this file's schema of the worktree's
// database, each run as `app`, on the LinkedIn fake and a clock the test sets, with the worker's
// decrypt entry registered as the worker registers it (importing workflows/index.ts): the account
// with the most company reads left reads the page, one `read_company` reserved, committed and logged
// with no object, counted in its daily reads; the share (LINKEDIN_COMPANY_READS_PER_DAY), 0 included;
// the read cap; the window; a kill switch and a health pause; no connected account; an unknown page,
// a failure before any call (released) and after one (committed, thrown); a link of another form; and
// no decrypt entry, outside the worker.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { tenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { loadMasterKeys, newMasterKey, servicePrincipal } from "@whytide/platform";
import { getAdapter, type LinkedinFake, linkedinPort } from "@whytide/providers";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import { type RefOpener, readCompany, useRefOpener } from "../domain/company/read.ts";
import { reserveReads } from "../domain/quota/reservations.ts";
import type { WorkingHours } from "../domain/working-hours.ts";
import {
  createConnectedAccount,
  setAccountPaused,
  setHealth,
  useClock,
  useCompanyReadShare,
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
let at = new Date("2026-10-22T10:00:00Z"); // Thursday 12:00 in Paris
useClock(() => at);
afterEach(() => {
  useCompanyReadShare(undefined);
  at = new Date("2026-10-22T10:00:00Z");
});

const OFFICE: WorkingHours = { start: "08:30", end: "18:00", days: [1, 2, 3, 4, 5] };
const PAGE = "https://linkedin.com/company/copper-harbor-labs";
const FACTS = {
  companyUrl: PAGE,
  name: "Copper Harbor Labs",
  website: "https://www.copperharbor.example/",
  industry: "Software Development",
  employeeCount: 140,
  employeeRange: { from: 51, to: 200 },
  headquartersCountry: "GB",
};

/** A workspace of its own with `count` connected accounts in Paris's office hours, each on the fake. */
async function workspaceWith(count: number) {
  const [{ workspace }] = await createTwoWorkspaces();
  const workspaceId = workspace.id;
  const accounts: { id: string; ref: string }[] = [];
  for (let i = 0; i < count; i++) {
    const ref = `fake-account-${workspaceId}-${i}`;
    fake.emitWebhook("account.connected", ref);
    const settings = { timeZone: "Europe/Paris", workingHours: OFFICE, providerAccountRef: ref };
    const { id } = await createConnectedAccount(workspaceId, settings);
    accounts.push({ id, ref });
  }
  const tenant = <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app });
  const context = { workspaceId, tenant };
  const read = (companyUrl = PAGE) => readCompany({ companyUrl }, context);
  /** `count` reads of a profile, as signals' reads use the day. */
  const use = (accountId: string, reads: number) =>
    tenant(() => reserveReads({ accountId, count: reads, kind: "read_profile" }));
  return { workspaceId, accounts, tenant, read, use };
}

const rows = async (senderAccountId: string) =>
  (
    await app.senderActionLog.findMany({
      where: { senderAccountId, kind: "read_company" },
      orderBy: { id: "asc" },
    })
  ).map(({ outcome, count, objectRef }) => [outcome, count, objectRef]);
const usage = async (senderAccountId: string) =>
  (await app.senderQuotaUsage.findMany({ where: { senderAccountId } })).map(
    ({ readsReserved, readsCommitted }) => [readsReserved, readsCommitted],
  );
const companyCalls = () => fake.recordedCalls.filter(({ method }) => method === "getCompany");

test("the account with the most company reads left reads the page: one read_company reserved, committed and logged ok with no object, in its daily reads", async () => {
  fake.reset();
  fake.seedCompany(PAGE, FACTS);
  const { accounts, read, use } = await workspaceWith(2);
  const [busy, idle] = accounts as [{ id: string; ref: string }, { id: string; ref: string }];
  await use(busy.id, 90);
  const answer = await read();
  assert.equal(answer.status, "read");
  assert.ok(answer.status === "read");
  const { fetchedAt, ...company } = answer.company;
  assert.deepEqual(company, FACTS);
  assert.deepEqual(
    companyCalls().map(({ input }) => input),
    [{ providerAccountRef: idle.ref, companyUrl: PAGE }],
  );
  assert.deepEqual(await rows(idle.id), [
    ["reserved", 1, null],
    ["ok", 1, null],
  ]);
  assert.deepEqual(await usage(idle.id), [[0, 1]]);
  assert.deepEqual(await rows(busy.id), []);
});

test("the share: two company reads a day, the third answers no_reads_left with no call, and reserveReads refuses read_cap_reached at the day's end; 0 turns them off", async () => {
  fake.reset();
  fake.seedCompany(PAGE, FACTS);
  useCompanyReadShare(2);
  const { accounts, read, tenant } = await workspaceWith(1);
  const [only] = accounts as [{ id: string; ref: string }];
  assert.equal((await read()).status, "read");
  assert.equal((await read()).status, "read");
  assert.deepEqual(await read(), { status: "no_reads_left" });
  assert.equal(companyCalls().length, 2);
  const refusal = await tenant(() =>
    reserveReads({ accountId: only.id, count: 1, kind: "read_company" }),
  );
  assert.deepEqual(refusal, {
    refused: "read_cap_reached",
    retryAt: new Date("2026-10-22T22:00:00.000Z"), // Friday 00:00 in Paris
  });
  // Other reads go on: the share holds company pages only.
  const profile = await tenant(() =>
    reserveReads({ accountId: only.id, count: 1, kind: "read_profile" }),
  );
  assert.ok("reservationId" in profile);
  at = new Date("2026-10-23T10:00:00Z"); // Friday: a new quota day, a new share
  assert.equal((await read()).status, "read");

  useCompanyReadShare(0);
  const off = await workspaceWith(1);
  assert.deepEqual(await off.read(), { status: "no_reads_left" });
  assert.equal(companyCalls().length, 3);
});

test("the read cap, the window, a kill switch and a health pause each answer no_reads_left with no call; no connected account, no_account", async () => {
  fake.reset();
  fake.seedCompany(PAGE, FACTS);
  const { accounts, read, use } = await workspaceWith(1);
  const [only] = accounts as [{ id: string; ref: string }];
  await use(only.id, 100);
  assert.deepEqual(await read(), { status: "no_reads_left" });

  const late = await workspaceWith(1);
  at = new Date("2026-10-22T17:00:00Z"); // Thursday 19:00 in Paris
  assert.deepEqual(await late.read(), { status: "no_reads_left" });
  at = new Date("2026-10-23T07:00:00Z"); // Friday 09:00
  assert.equal((await late.read()).status, "read");

  const [lateAccount] = late.accounts as [{ id: string; ref: string }];
  await setAccountPaused(lateAccount.id, "tester");
  assert.deepEqual(await late.read(), { status: "no_reads_left" });
  await setAccountPaused(lateAccount.id, null);
  await setHealth(lateAccount.id, "restricted", { pausedUntil: new Date("2026-10-24T00:00:00Z") });
  assert.deepEqual(await late.read(), { status: "no_reads_left" });
  assert.equal(companyCalls().length, 1);

  const none = await workspaceWith(0);
  assert.deepEqual(await none.read(), { status: "no_account" });
  const gone = await workspaceWith(1);
  const [goneAccount] = gone.accounts as [{ id: string; ref: string }];
  await app.senderAccount.update({
    where: { id: goneAccount.id },
    data: { status: "disconnected" },
  });
  assert.deepEqual(await gone.read(), { status: "no_account" });
  assert.equal(companyCalls().length, 1);
});

test("an unknown page is not_found, its read committed; a failure before any call releases it; a provider error after the call is thrown, committed and logged", async () => {
  fake.reset();
  const { accounts, read } = await workspaceWith(1);
  const [only] = accounts as [{ id: string; ref: string }];
  assert.deepEqual(await read(), { status: "not_found" });
  assert.deepEqual(await usage(only.id), [[0, 1]]);

  fake.seedCompany(PAGE, FACTS);
  fake.failNext("linkedin_provider_error");
  await assert.rejects(read(), { code: "linkedin_provider_error" });
  assert.deepEqual(await usage(only.id), [[0, 2]]);

  // The reference cleared: the entry throws before any call, and the read is released.
  await app.senderAccount.update({ where: { id: only.id }, data: { providerAccountRef: null } });
  await assert.rejects(read(), { code: "linkedin_account_disconnected" });
  assert.deepEqual(await usage(only.id), [[0, 2]]);
  assert.deepEqual(await rows(only.id), [
    ["reserved", 1, null],
    ["linkedin_not_found", 1, null],
    ["reserved", 1, null],
    ["linkedin_provider_error", 1, null],
    ["reserved", 1, null],
  ]);
});

test("a link that is no company page is read_input_invalid, and outside the worker readCompany is company_read_unavailable; neither reserves", async () => {
  fake.reset();
  const { accounts, read } = await workspaceWith(1);
  const [only] = accounts as [{ id: string; ref: string }];
  await assert.rejects(read("https://www.linkedin.com/in/ada-example"), {
    code: "read_input_invalid",
  });
  const entry: RefOpener = (context, id, fn) =>
    withDecryptedRef(
      {
        workspaceId: context.workspaceId,
        tenant: (run) => context.tenant(() => run(tenantClient)),
      },
      id,
      fn,
    );
  useRefOpener(undefined);
  try {
    await assert.rejects(read(), { code: "company_read_unavailable" });
  } finally {
    useRefOpener(entry);
  }
  assert.deepEqual(await rows(only.id), []);
  assert.equal(companyCalls().length, 0);
});
