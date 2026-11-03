// linkedin's risk disclosure for sending through the routes (beta-p1-070; core/modules/linkedin
// README.md "API"): the host started with identity and linkedin on the fakes, in a schema of the
// worktree's database, answering real HTTP. POST …/accounts/{id}/disclosure: the owner's acceptance,
// the codes, which store nothing, a double press under one Idempotency-Key; connect's new body; the
// account's disclosureVersion and sendingDisclosureRequired on every route that answers the account.
// The send refusals are linkedin's tests/safety/disclosure.test.ts. It lives here: a module never
// imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import type { Api } from "../src/start.ts";

// The host reads it as its config loads, the hosted link's return address at each connect.
process.env.APP_PUBLIC_ORIGIN = "https://app.whytide.test";
const { start } = await import("../src/start.ts");
// linkedin by its build's path, as src/modules.generated.ts loads it (linkedin-accounts.test.ts).
const build = new URL("../../../../modules/linkedin/dist/", import.meta.url);
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
const testing: LinkedinTesting = await import(new URL("testing/index.js", build).href);
const { createConnectedAccount } = testing;

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
testing.useLinkedinClient(app);
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "linkedin", load: () => import(new URL("index.js", build).href) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

type Answer = { status: number; body: any; replayed: string | null };

/** A call to …/linkedin<path> in the workspace, as the user, from the app; a POST with its key. */
async function call(
  userId: string,
  workspaceId: string,
  method: string,
  path: string,
  options: { body?: unknown; key?: string } = {},
): Promise<Answer> {
  const cookie = signInAs(userId)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers: Record<string, string> = { cookie, "sec-fetch-site": "same-origin" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.key !== undefined) headers["idempotency-key"] = options.key;
  const url = new URL(`/v1/workspaces/${workspaceId}/linkedin${path}`, api.url);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  const replayed = res.headers.get("idempotent-replayed");
  return { status: res.status, body: text ? JSON.parse(text) : undefined, replayed };
}

const ACCEPTED = { version: 2, personalAccount: true };
const refusal = (status: number, code: string) => ({ status, body: { code }, replayed: null });

test("POST …/disclosure: only the owner accepts; another member is 403 not_account_owner, version 1 or 3 disclosure_version_invalid, personalAccount false personal_account_required, an outsider 403, another workspace's account 404, none storing anything; the owner's acceptance answers the account, which a double press under one key answers once and a later press the same", async () => {
  const [a, b] = await createTwoWorkspaces();
  const owner = a.user.id;
  const ws = a.workspace.id;
  const settings = { ownerUserId: owner, disclosureVersion: 1, personalAccount: false };
  const { id } = await createConnectedAccount(ws, settings);
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId: ws });
  const accept = (userId: string, body: unknown, key = randomUUID(), workspaceId = ws) =>
    call(userId, workspaceId, "POST", `/accounts/${id}/disclosure`, { body, key });
  const stored = async () => {
    const row = await app.senderAccount.findUniqueOrThrow({ where: { id } });
    return [row.disclosureVersion, row.disclosureAcknowledgedAt, row.personalAccountConfirmedAt];
  };
  const before = await stored();

  const listed = (await call(owner, ws, "GET", "/accounts")).body.accounts;
  assert.deepEqual(
    listed.map((account: Answer["body"]) => [
      account.disclosureVersion,
      account.sendingDisclosureRequired,
    ]),
    [[1, true]],
  );
  assert.deepEqual(await accept(member.id, ACCEPTED), refusal(403, "not_account_owner"));
  for (const version of [1, 3]) {
    const invalid = await accept(owner, { version, personalAccount: true });
    assert.deepEqual(invalid, refusal(400, "disclosure_version_invalid"));
  }
  const notPersonal = await accept(owner, { version: 2, personalAccount: false });
  assert.deepEqual(notPersonal, refusal(400, "personal_account_required"));
  assert.deepEqual(await accept(b.user.id, ACCEPTED), refusal(403, "forbidden"));
  const elsewhere = await accept(b.user.id, ACCEPTED, randomUUID(), b.workspace.id);
  assert.deepEqual(elsewhere, refusal(404, "sender_account_not_found"));
  const keyless = await call(owner, ws, "POST", `/accounts/${id}/disclosure`, { body: ACCEPTED });
  assert.equal(keyless.status, 400);
  assert.deepEqual(await stored(), before, "a refused call stores nothing");

  const key = randomUUID();
  const first = await accept(owner, ACCEPTED, key);
  assert.deepEqual(
    [
      first.status,
      first.body.id,
      first.body.disclosureVersion,
      first.body.sendingDisclosureRequired,
    ],
    [200, id, 2, false],
  );
  const accepted = await stored();
  assert.deepEqual(await accept(owner, ACCEPTED, key), { ...first, replayed: "true" });
  assert.deepEqual(await accept(owner, ACCEPTED), first, "a later press answers the same");
  assert.deepEqual(await stored(), accepted, "and stores nothing new");
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id } });
  assert.equal(row.disclosureVersion, 2);
  assert.equal(row.personalAccountConfirmedAt?.getTime(), row.disclosureAcknowledgedAt.getTime());
});

test("connect's new body: without the current version disclosure_required, without personalAccount true personal_account_required, neither storing an account; with both, the pending account holds version 2 and the confirmation", async () => {
  const [a] = await createTwoWorkspaces();
  const owner = a.user.id;
  const ws = a.workspace.id;
  const connect = (body: unknown) => call(owner, ws, "POST", "/accounts/connect", { body });
  const timeZone = "Europe/Paris";
  const cases = [
    [{ timeZone, acknowledged: true }, "disclosure_required"],
    [
      { timeZone, acknowledged: true, disclosureVersion: 1, personalAccount: true },
      "disclosure_required",
    ],
    [
      { timeZone, acknowledged: false, disclosureVersion: 2, personalAccount: true },
      "disclosure_required",
    ],
    [{ timeZone, acknowledged: true, disclosureVersion: 2 }, "personal_account_required"],
    [
      { timeZone, acknowledged: true, disclosureVersion: 2, personalAccount: false },
      "personal_account_required",
    ],
  ] as const;
  for (const [body, code] of cases) assert.deepEqual(await connect(body), refusal(400, code));
  assert.equal(await app.senderAccount.count({ where: { workspaceId: ws } }), 0);

  const started = await connect({
    timeZone,
    acknowledged: true,
    ...{ disclosureVersion: 2, personalAccount: true },
  });
  assert.equal(started.status, 200);
  const row = await app.senderAccount.findFirstOrThrow({ where: { workspaceId: ws } });
  assert.deepEqual([row.status, row.disclosureVersion], ["pending", 2]);
  assert.equal(row.personalAccountConfirmedAt?.getTime(), row.disclosureAcknowledgedAt.getTime());
});

test("PATCH …/accounts/{id} and POST …/refresh answer disclosureVersion and sendingDisclosureRequired: required at version 2 without the confirmation, not once confirmed", async () => {
  const [a] = await createTwoWorkspaces();
  const owner = a.user.id;
  const ws = a.workspace.id;
  const unconfirmed = await createConnectedAccount(ws, {
    ownerUserId: owner,
    personalAccount: false,
  });
  const fields = (answer: Answer) => [
    answer.status,
    answer.body.disclosureVersion,
    answer.body.sendingDisclosureRequired,
  ];
  const patch = { body: { label: "Mine" } };
  const patched = await call(owner, ws, "PATCH", `/accounts/${unconfirmed.id}`, patch);
  assert.deepEqual(fields(patched), [200, 2, true]);
  const asked = { key: randomUUID() };
  const refreshed = await call(owner, ws, "POST", `/accounts/${unconfirmed.id}/refresh`, asked);
  assert.deepEqual(fields(refreshed), [202, 2, true]);
  await call(owner, ws, "POST", `/accounts/${unconfirmed.id}/disclosure`, {
    body: ACCEPTED,
    key: randomUUID(),
  });
  const after = await call(owner, ws, "PATCH", `/accounts/${unconfirmed.id}`, patch);
  assert.deepEqual(fields(after), [200, 2, false]);
});
