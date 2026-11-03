// linkedin's sender accounts end to end (alpha-p7-030; core/modules/linkedin/README.md "API"): the
// host started with identity and linkedin on the fake adapters, in a schema of the worktree's
// database, answering real HTTP. The fake's connect route is mounted on the host, where the web's
// rewrite of /api/linkedin/* reaches it; a visit posts the fake's signed webhook to the host's
// webhook route. Criteria 1 (the api's part), 2 (the raw read), 3 and 4; the screen's part is the
// web's Playwright spec. fix-read-cap's criteria 1 to 3: the daily read cap's PATCH. It lives here: a
// module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, loadMasterKeys, newMasterKey } from "@whytide/platform";
import {
  getAdapter,
  type LinkedinFake,
  type LinkedinWebhook,
  linkedinPort,
} from "@whytide/providers";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads, the hosted link's return address at each connect.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
// The cap's bound, read as linkedin loads: its default, 100, whatever .env.local says. Empty, not
// deleted: an empty value counts as unset, and db's loadEnvLocal fills only a variable not set.
process.env.LINKEDIN_DAILY_READ_CAP_MAX = "";
const { start } = await import("../src/start.ts");
// linkedin by its build's path, as src/modules.generated.ts loads it: the api does not list a module
// with a screen (core/apps/web/docs/screens.md).
const build = new URL("../../../../modules/linkedin/dist/", import.meta.url);
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
const testing: LinkedinTesting = await import(new URL("testing/index.js", build).href);
const { useLinkedinClient, useSecretKeys } = testing;

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
useLinkedinClient(app);
useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
/** The webhooks the visits posted, with the host's answers. */
const delivered: { rawBody: string; status: number }[] = [];
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  const connect = fake.connectOnVisit(async (webhook) => {
    const { status } = await post(webhook);
    delivered.push({ rawBody: String(webhook.rawBody), status });
  });
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "linkedin", load: () => import(new URL("index.js", build).href) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
    mount: [connect],
  });
});
after(() => api?.close());

type Answer = { status: number; body: any };

const answer = async (res: Response): Promise<Answer> => {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};

/** A call to …/linkedin/accounts<path> in the tenant's workspace, as its Owner, from the app. */
async function call(
  tenant: TestTenant,
  method: string,
  path = "",
  body?: unknown,
  more: Record<string, string> = {},
) {
  const cookie = signInAs(tenant.user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers: Record<string, string> = { ...more, cookie, "sec-fetch-site": "same-origin" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const url = new URL(`/v1/workspaces/${tenant.workspace.id}/linkedin/accounts${path}`, api.url);
  const json = body === undefined ? undefined : JSON.stringify(body);
  return answer(await fetch(url, { method, headers, body: json }));
}

/** The vendor's call: no cookie, no workspace. */
async function post({ headers, rawBody }: LinkedinWebhook): Promise<Answer> {
  const url = new URL("/v1/linkedin/webhooks/fake", api.url);
  const init = { method: "POST", headers: headers as Record<string, string>, body: rawBody };
  return answer(await fetch(url, init));
}

/** Connect, then follow the hosted link as the browser would: the account and its reference. */
async function connect(tenant: TestTenant, timeZone = "Pacific/Auckland") {
  const disclosure = { acknowledged: true, disclosureVersion: 2, personalAccount: true };
  const started = await call(tenant, "POST", "/connect", { timeZone, ...disclosure });
  assert.equal(started.status, 200);
  const link = new URL(started.body.url);
  assert.equal(link.origin, APP_ORIGIN);
  const visit = await fetch(new URL(`${link.pathname}${link.search}`, api.url), {
    redirect: "manual",
  });
  const back = `${APP_ORIGIN}/w/${tenant.workspace.id}/linkedin?connect=done`;
  assert.deepEqual([visit.status, visit.headers.get("location")], [303, back]);
  const webhook = delivered.at(-1);
  assert.equal(webhook?.status, 204);
  const { accounts } = (await call(tenant, "GET")).body;
  return { account: accounts[0], ref: String(JSON.parse(webhook.rawBody).account) };
}

const events = async (tenant: TestTenant) =>
  (
    await app.outboxEntry.findMany({
      where: { workspaceId: tenant.workspace.id },
      orderBy: { id: "asc" },
    })
  ).map(({ eventName, payload }) => [eventName, payload]);

test("connect: 400 disclosure_required without the acknowledgment; with it, the hosted link's visit connects the account in the zone given, its reference sealed", async () => {
  const [a] = await createTwoWorkspaces();
  const body = { timeZone: "Pacific/Auckland", acknowledged: false };
  assert.deepEqual(await call(a, "POST", "/connect", body), {
    status: 400,
    body: { code: "disclosure_required" },
  });
  assert.deepEqual(await call(a, "GET"), { status: 200, body: { accounts: [] } });

  const { account, ref } = await connect(a);
  assert.deepEqual(account, {
    id: account.id,
    label: "LinkedIn",
    status: "connected",
    timeZone: "Pacific/Auckland",
    workingHours: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] },
    dailyReadCap: 100,
    mine: true,
    canManage: true,
    paused: false,
    pausedBy: null,
    disclosureVersion: 2,
    sendingDisclosureRequired: false,
  });
  const [raw] = await app.$queryRaw<{ ref: Uint8Array }[]>`
    SELECT provider_account_ref AS ref FROM sender_accounts WHERE id = ${account.id}`;
  assert.ok(ref.startsWith("fake-account-") && raw && raw.ref.length > 0);
  assert.equal(Buffer.from(raw.ref).includes(ref), false);
  const connected = ["linkedin.sender_account_connected", { sender_account_id: account.id }];
  assert.deepEqual(await events(a), [connected]);
});

test("the webhook: a wrong signature is 401 linkedin_webhook_invalid and changes nothing; a signed account.disconnected sets disconnected and publishes it", async () => {
  const [a] = await createTwoWorkspaces();
  const { account, ref } = await connect(a);
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id: account.id } });
  const published = await events(a);
  const webhook = fake.emitWebhook("account.disconnected", ref);
  const zeroed = Object.entries(webhook.headers).map(([name, value]) => [
    name,
    String(value).startsWith("sha256=") ? `sha256=${"0".repeat(64)}` : value,
  ]);
  assert.deepEqual(await post({ ...webhook, headers: Object.fromEntries(zeroed) }), {
    status: 401,
    body: {
      code: "linkedin_webhook_invalid",
      details: { method: "parseWebhook", reason: "signature" },
    },
  });
  assert.deepEqual(await app.senderAccount.findUniqueOrThrow({ where: { id: account.id } }), row);
  assert.deepEqual(await events(a), published);

  assert.deepEqual(await post(webhook), { status: 204, body: undefined });
  const { accounts } = (await call(a, "GET")).body;
  assert.deepEqual([accounts[0].id, accounts[0].status], [account.id, "disconnected"]);
  const disconnected = ["linkedin.sender_account_disconnected", { sender_account_id: account.id }];
  const [health] = await app.senderHealthEvent.findMany({ where: { senderId: account.id } });
  const payload = { sender_account_id: account.id, health_event_id: health?.id };
  const all = await events(a);
  assert.deepEqual(all.slice(0, published.length), published);
  // The health's pause (beta-p6-010) in the same run, at one transaction time: by name.
  const added = all.slice(published.length).sort();
  assert.deepEqual(added, [["linkedin.account_paused", payload], disconnected]);
});

test("PATCH the working hours: start after end, or a day outside 1 to 7, is 400 working_hours_invalid; valid hours save and the list shows them", async () => {
  const [a, b] = await createTwoWorkspaces();
  const { account } = await connect(a, "Europe/Paris");
  const patch = (workingHours: unknown) => call(a, "PATCH", `/${account.id}`, { workingHours });
  const refused = (field: string) => ({
    status: 400,
    body: { code: "working_hours_invalid", details: { fields: [`workingHours.${field}`] } },
  });
  assert.deepEqual(await patch({ start: "18:00", end: "08:30", days: [1, 2] }), refused("end"));
  assert.deepEqual(await patch({ start: "08:30", end: "18:00", days: [1, 8] }), refused("days"));

  const hours = { start: "08:30", end: "17:00", days: [1, 3, 5] };
  const saved = await patch({ ...hours, days: [5, 1, 3] });
  assert.deepEqual([saved.status, saved.body.workingHours], [200, hours]);
  const { accounts } = (await call(a, "GET")).body;
  assert.deepEqual([accounts[0].workingHours, accounts[0].timeZone], [hours, "Europe/Paris"]);
  assert.deepEqual(await call(b, "PATCH", `/${account.id}`, { workingHours: hours }), {
    status: 404,
    body: { code: "sender_account_not_found" },
  });
});

test("PATCH the daily read cap: 100, the most, is stored and listed after 40; 0, 101, 250, 1.5 or a string is 400 read_cap_invalid with details.max 100 and stores nothing; a user without linkedin.manage in the workspace is 403, another workspace's account 404", async () => {
  const [a, b] = await createTwoWorkspaces();
  const { account } = await connect(a);
  const patch = (tenant: TestTenant, dailyReadCap: unknown) =>
    call(tenant, "PATCH", `/${account.id}`, { dailyReadCap });
  assert.deepEqual(await patch(a, 40), { status: 200, body: { ...account, dailyReadCap: 40 } });
  const saved = await patch(a, 100);
  assert.deepEqual(saved, { status: 200, body: { ...account, dailyReadCap: 100 } });
  assert.deepEqual(await call(a, "GET"), { status: 200, body: { accounts: [saved.body] } });

  const details = { fields: ["dailyReadCap"], max: 100 };
  const refused = { status: 400, body: { code: "read_cap_invalid", details } };
  for (const cap of [0, 101, 250, 1.5, "100"]) {
    assert.deepEqual(await patch(a, cap), refused, `${cap}`);
  }
  // B's user is no member of A's workspace: alpha's can() evaluates no role, so that is who lacks it.
  const outsider = { ...a, user: b.user };
  assert.deepEqual(await patch(outsider, 50), { status: 403, body: { code: "forbidden" } });
  const notFound = { status: 404, body: { code: "sender_account_not_found" } };
  assert.deepEqual(await patch(b, 50), notFound);
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id: account.id } });
  assert.equal(row.dailyReadCap, 100);
});

test("refresh: 202 with the account as it stands and linkedin.status_refresh_requested published, for the worker; another workspace's account is 404 sender_account_not_found", async () => {
  const [a, b] = await createTwoWorkspaces();
  const { account } = await connect(a);
  const published = await events(a);
  const refresh = (tenant: TestTenant) =>
    call(tenant, "POST", `/${account.id}/refresh`, undefined, { "idempotency-key": randomUUID() });
  assert.deepEqual(await refresh(a), { status: 202, body: account });
  const requested = ["linkedin.status_refresh_requested", { sender_account_id: account.id }];
  assert.deepEqual(await events(a), [...published, requested]);
  assert.deepEqual(await refresh(b), { status: 404, body: { code: "sender_account_not_found" } });
  assert.deepEqual(await events(b), []);
});
