// email's mailboxes end to end (gamma-p1-010; core/modules/email/README.md "API"): the host started
// with identity and email on the fakes, in a schema of the worktree's database, answering real HTTP.
// The mailbox fake's consent address is the callback itself, with a code and the state, so a test
// follows it as the callback page does. Connect and callback for Google and Microsoft, with the
// verifier the fake's exchange receives; every refusal; the list and the raw column without a
// token; the owner-only disconnect and a reconnect; a Member's list of their own mailboxes, since
// can() checks roles (gamma-p6-010). It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import type { MailboxFake } from "@whytide/providers";
import type { TestTenant } from "@whytide/tenancy/testing";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// Read as the host's config and the providers load: the consent's return address, the fake adapter.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
process.env.PROVIDER_MAILBOX = "fake";
const { databaseUrl } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { useIdentityClient } = await import("@whytide/identity/testing");
const { collectLogs, createLogger, loadMasterKeys, newMasterKey } = await import(
  "@whytide/platform"
);
const { codeChallengeFor, getAdapter, mailboxPort } = await import("@whytide/providers");
const { signInAs } = await import("@whytide/providers/auth/testing");
const tenancy = await import("@whytide/tenancy/testing");
const { createMembership, createTwoWorkspaces, createUser, useTenancyClient } = tenancy;
const { start } = await import("../src/start.ts");
// email by its build's path, as src/modules.generated.ts loads it: the api lists no module with a
// screen (core/apps/web/docs/screens.md).
const build = new URL("../../../../modules/email/dist/", import.meta.url);
type EmailTesting = typeof import("../../../modules/email/dist/testing/index.js");
const testing: EmailTesting = await import(new URL("testing/index.js", build).href);
const { useClock, useEmailClient, useSecretKeys } = testing;

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
useEmailClient(app);
useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
const fake = (await getAdapter(mailboxPort, "fake")) as unknown as MailboxFake;
const logs = collectLogs();
const FAKE_ADDRESS = "member@fake-mailbox.example";
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: logs.destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "email", load: () => import(new URL("index.js", build).href) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

type Answer = { status: number; body: any };
/** Who calls: a workspace and a member of it. */
type Caller = { workspaceId: string; userId: string };
const as = (tenant: TestTenant): Caller => ({
  workspaceId: tenant.workspace.id,
  userId: tenant.user.id,
});
/** Every answer's text but the consent address's, which carries the code and the state by design. */
const answers: string[] = [];

/** A call to …/email/mailboxes<path> in the caller's workspace, from the app. */
async function call(caller: Caller, method: string, path = "", body?: unknown): Promise<Answer> {
  const cookie = signInAs(caller.userId)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers: Record<string, string> = { cookie, "sec-fetch-site": "same-origin" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const url = new URL(`/v1/workspaces/${caller.workspaceId}/email/mailboxes${path}`, api.url);
  const json = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, { method, headers, body: json });
  const text = await res.text();
  if (path !== "/connect") answers.push(text);
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/** The consent address's state and code, as the callback page reads them. */
async function consent(caller: Caller, provider = "google", timeZone = "Europe/Berlin") {
  const started = await call(caller, "POST", "/connect", { provider, timeZone });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const url = new URL(started.body.url);
  assert.equal(`${url.origin}${url.pathname}`, `${APP_ORIGIN}/email/callback`);
  return { state: url.searchParams.get("state") ?? "", code: url.searchParams.get("code") ?? "" };
}

/** Connect through the consent and the callback: the callback's answer. */
async function connect(caller: Caller, address?: string | null, provider = "google") {
  const params = await consent(caller, provider);
  if (address !== undefined) fake.consentNext({ address });
  return call(caller, "POST", "/callback", params);
}

const methods = (name: string) => fake.recordedCalls.filter(({ method }) => method === name);
const mailboxes = (workspaceId: string) => app.mailbox.findMany({ where: { workspaceId } });
const events = async (workspaceId: string) =>
  (await app.outboxEntry.findMany({ where: { workspaceId }, orderBy: { id: "asc" } })).map(
    ({ eventName, payload }) => [eventName, payload],
  );
const refused = (status: number, code: string) => ({ status, body: { code } });

test("Google and Microsoft connect on the fake: the mailbox the exchange proves, connected, its tokens sealed; the exchange gets the verifier of the consent's challenge; no answer, row, event or log line holds a token, the code or the verifier", async () => {
  const [a, b] = await createTwoWorkspaces();
  const { state, code } = await consent(as(a));
  assert.match(state, new RegExp(`^${a.workspace.id}\\.[A-Za-z0-9_-]{43}$`));
  const challenge = (methods("createAuthUrl").at(-1)?.input as { codeChallenge: string })
    .codeChallenge;
  const stored = await call(as(a), "POST", "/callback", { state, code });
  assert.equal(stored.status, 200);
  const { id, connectedAt } = stored.body;
  assert.match(id, /^mbx_/);
  assert.deepEqual(stored.body, {
    id,
    ownerUserId: a.user.id,
    mine: true,
    provider: "google",
    emailAddress: FAKE_ADDRESS,
    displayName: stored.body.displayName,
    status: "connected",
    disconnectedReason: null,
    isFreeConsumer: false,
    timeZone: "Europe/Berlin",
    connectedAt,
    disconnectedAt: null,
  });
  assert.deepEqual((await call(as(a), "GET")).body, { mailboxes: [stored.body] });
  const exchange = methods("exchangeCode").at(-1)?.input as { codeVerifier: string };
  assert.equal(exchange.codeVerifier.length, 43);
  assert.equal(codeChallengeFor(exchange.codeVerifier), challenge);
  const [raw] = await app.$queryRaw<{ ref: Uint8Array }[]>`
    SELECT oauth_token_ref AS ref FROM mailboxes WHERE id = ${id}`;
  assert.ok(raw && Buffer.from(raw.ref).subarray(0, 2).toString() === "v1");
  for (const plain of ["fake-refresh-", "fake-access-"]) {
    assert.equal(Buffer.from(raw.ref).includes(plain), false, plain);
  }
  assert.deepEqual(await events(a.workspace.id), [["email.mailbox_connected", { mailbox_id: id }]]);

  fake.consentNext({ address: "Sales.Lead@B-Corp.example" });
  const microsoft = await call(as(b), "POST", "/callback", await consent(as(b), "microsoft"));
  assert.equal(microsoft.status, 200);
  assert.deepEqual(
    [microsoft.body.provider, microsoft.body.emailAddress, microsoft.body.status],
    ["microsoft", "sales.lead@b-corp.example", "connected"],
  );

  const rows = await app.mailboxConnect.findMany({ where: { workspaceId: a.workspace.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.stateHash.length, 64);
  const kept = JSON.stringify([
    rows,
    await mailboxes(a.workspace.id),
    await events(a.workspace.id),
    answers,
    logs.raw,
  ]);
  const nonce = state.slice(state.indexOf(".") + 1);
  for (const secret of [code, nonce, exchange.codeVerifier, "fake-refresh-", "fake-access-"]) {
    assert.equal(kept.includes(secret), false, `${secret.slice(0, 13)}… was kept`);
  }
});

test("a state unknown, of another form, from another workspace, another member's, older than 10 minutes or used is connect_state_invalid before any exchange, and stores nothing", async () => {
  const [a, b] = await createTwoWorkspaces();
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId: a.workspace.id, role: "Member" });
  const teammate = { workspaceId: a.workspace.id, userId: member.id };
  const invalid = refused(400, "connect_state_invalid");
  const exchanges = methods("exchangeCode").length;
  const { state, code } = await consent(as(a));
  const unknown = `${a.workspace.id}.${randomBytes(32).toString("base64url")}`;
  assert.deepEqual(await call(as(a), "POST", "/callback", { state: unknown, code }), invalid);
  assert.deepEqual(await call(as(a), "POST", "/callback", { state: "nope", code }), invalid);
  assert.deepEqual(await call(as(b), "POST", "/callback", { state, code }), invalid);
  assert.deepEqual(await call(teammate, "POST", "/callback", { state, code }), invalid);
  const later = Date.now() + 10 * 60 * 1000 + 1;
  useClock(() => new Date(later));
  try {
    assert.deepEqual(await call(as(a), "POST", "/callback", { state, code }), invalid);
  } finally {
    useClock(undefined);
  }
  assert.equal(methods("exchangeCode").length, exchanges, "no exchange for a refused state");
  assert.equal((await mailboxes(a.workspace.id)).length, 0);
  assert.equal((await call(as(a), "POST", "/callback", { state, code })).status, 200);
  assert.deepEqual(await call(as(a), "POST", "/callback", { state, code }), invalid);
  assert.equal(methods("exchangeCode").length, exchanges + 1);
});

test("a consent short of send and read, or with no address, is mailbox_consent_incomplete: one revoke from memory, no mailbox", async () => {
  const [a] = await createTwoWorkspaces();
  const revokes = methods("revokeAccess").length;
  const incomplete = refused(400, "mailbox_consent_incomplete");
  const short = await consent(as(a));
  fake.consentNext({ scopes: ["send"] });
  assert.deepEqual(await call(as(a), "POST", "/callback", short), incomplete);
  assert.equal(methods("revokeAccess").length, revokes + 1);
  assert.deepEqual(await connect(as(a), null), incomplete);
  assert.equal(methods("revokeAccess").length, revokes + 2);
  assert.equal((await mailboxes(a.workspace.id)).length, 0);
});

test("an address connected in another workspace, or another member's here, is mailbox_in_use, stored nowhere and not revoked; a second mailbox is mailbox_exists; a bad zone mailbox_time_zone_invalid", async () => {
  const [a, b] = await createTwoWorkspaces();
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId: a.workspace.id, role: "Member" });
  const teammate = { workspaceId: a.workspace.id, userId: member.id };
  const revokes = methods("revokeAccess").length;
  assert.equal((await connect(as(b), "taken@shared.example")).status, 200);
  assert.deepEqual(await connect(as(a), "taken@shared.example"), refused(409, "mailbox_in_use"));
  assert.equal((await mailboxes(a.workspace.id)).length, 0);

  const mine = await connect(as(a), "owner@a-corp.example");
  assert.equal(mine.status, 200);
  const again = { provider: "google", timeZone: "UTC" };
  assert.deepEqual(await call(as(a), "POST", "/connect", again), refused(409, "mailbox_exists"));
  assert.equal((await call(as(a), "DELETE", `/${mine.body.id}`)).status, 204);
  assert.deepEqual(await connect(teammate, "owner@a-corp.example"), refused(409, "mailbox_in_use"));
  assert.equal(methods("revokeAccess").length, revokes, "no revoke of a mailbox in use");
  assert.equal((await mailboxes(a.workspace.id)).length, 1);
  const zone = { provider: "google", timeZone: "Mars/Olympus_Mons" };
  assert.deepEqual(
    await call(teammate, "POST", "/connect", zone),
    refused(400, "mailbox_time_zone_invalid"),
  );
});

test("a free consumer address connects lowercased with isFreeConsumer; Disconnect sets disconnected at once and keeps the tokens for the worker; reconnecting the address keeps its id; only its owner disconnects it, and another workspace's is email_mailbox_not_found; a Member's list holds their own mailboxes only, an Owner's every mailbox here", async () => {
  const [a, b] = await createTwoWorkspaces();
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId: a.workspace.id, role: "Member" });
  const teammate = { workspaceId: a.workspace.id, userId: member.id };
  const free = await connect(as(a), "Some.One@GMAIL.com");
  const { id } = free.body;
  assert.deepEqual(
    [free.body.emailAddress, free.body.isFreeConsumer],
    ["some.one@gmail.com", true],
  );
  const domains = await app.sendingDomain.findMany({ where: { workspaceId: a.workspace.id } });
  assert.deepEqual(
    domains.map(({ domain }) => domain),
    ["gmail.com"],
  );

  assert.deepEqual(await call(teammate, "DELETE", `/${id}`), refused(403, "not_mailbox_owner"));
  assert.deepEqual(await call(as(b), "DELETE", `/${id}`), refused(404, "email_mailbox_not_found"));
  assert.equal((await call(as(a), "DELETE", `/${id}`)).status, 204);
  const [gone] = (await call(as(a), "GET")).body.mailboxes;
  assert.deepEqual([gone.id, gone.status, gone.disconnectedReason], [id, "disconnected", "user"]);
  assert.ok(gone.disconnectedAt);
  const row = await app.mailbox.findUniqueOrThrow({ where: { id } });
  assert.ok(row.oauthTokenRef, "the worker revokes the tokens, then nulls them");
  const disconnected = ["email.mailbox_disconnected", { mailbox_id: id, reason: "user" }];
  assert.deepEqual((await events(a.workspace.id)).at(-1), disconnected);
  assert.equal(
    (await call(as(a), "DELETE", `/${id}`)).status,
    204,
    "a second press changes nothing",
  );
  assert.equal((await events(a.workspace.id)).length, 2);

  const back = await connect(as(a), "some.one@gmail.com", "microsoft");
  assert.deepEqual(
    [back.body.id, back.body.status, back.body.disconnectedReason, back.body.provider],
    [id, "connected", null, "microsoft"],
  );
  assert.equal((await mailboxes(a.workspace.id)).length, 1);

  const theirs = await connect(teammate, "teammate@example.com");
  assert.equal(theirs.status, 200);
  const listed = async (caller: Caller) =>
    (await call(caller, "GET")).body.mailboxes.map((mailbox: { id: string; mine: boolean }) => [
      mailbox.id,
      mailbox.mine,
    ]);
  assert.deepEqual(await listed(as(a)), [
    [id, true],
    [theirs.body.id, false],
  ]);
  // email.manage is the Owner's and Admin's: a Member's list is their own.
  assert.deepEqual(await listed(teammate), [[theirs.body.id, true]]);
});
