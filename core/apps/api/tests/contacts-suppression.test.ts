// contacts' never-contact routes end to end (beta-p2-010; core/modules/contacts/README.md "Routes"):
// the host started with identity, whose resolver guards the workspace, and contacts, on the fake
// authentication adapter, in a schema of the worktree's database, answering real HTTP. It lives
// here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { upsertCompany, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createTwoWorkspaces,
  createUser,
  type TestTenant,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
useHashSalt("test-salt-".repeat(4));
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "contacts", load: () => import("@whytide/contacts") },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

/** In the tenant's workspace, as an import writes. */
const asService = <T>({ workspace }: TestTenant, fn: () => Promise<T>) =>
  withTenant({ workspaceId: workspace.id, principal: servicePrincipal("contacts_test") }, fn, {
    client: asRole("app"),
  });
const person = (tenant: TestTenant, slug: string, firstName: string, lastName?: string) =>
  asService(tenant, async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName, lastName };
    return (await upsertPersonFromSource({ source: "import", provider: "csv", profile })).person;
  });
const company = (
  tenant: TestTenant,
  name: string,
  keys: { domain?: string; linkedinUrl?: string },
) =>
  asService(tenant, async () => {
    const input = { source: "import", provider: "csv", company: { name, ...keys } } as const;
    return (await upsertCompany(input)).company;
  });

type Answer = { status: number; body: any; replayed: string | null };
/**
 * A call to …/contacts/suppression<path> in the tenant's workspace, from the app, as its Owner
 * unless `userId` is given; a POST carries a new Idempotency-Key unless `key` is given, or null.
 */
async function call(
  tenant: TestTenant,
  method: string,
  path = "",
  body?: unknown,
  options: { key?: string | null; userId?: string } = {},
): Promise<Answer> {
  const cookie = signInAs(options.userId ?? tenant.user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers: Record<string, string> = { cookie, origin: APP_ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  const key = options.key === undefined ? randomUUID() : options.key;
  if (method === "POST" && key !== null) headers["idempotency-key"] = key;
  const url = new URL(`/v1/workspaces/${tenant.workspace.id}/contacts/suppression${path}`, api.url);
  const json = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, { method, headers, body: json });
  const text = await res.text();
  const replayed = res.headers.get("idempotent-replayed");
  return { status: res.status, body: text ? JSON.parse(text) : undefined, replayed };
}
const add = (tenant: TestTenant, body: object, key?: string) =>
  call(tenant, "POST", "", body, { key });
const listed = async (tenant: TestTenant) =>
  (await call(tenant, "GET")).body.entries.map((entry: { id: string }) => entry.id);

test("POST …/suppression adds a person and a company, each by id and by value, 201 with the entry; GET lists them newest first with what they name; an active entry added again answers unchanged; the same Idempotency-Key replays the first answer", async () => {
  const [a] = await createTwoWorkspaces();
  const rae = await person(a, "rae-moss", "Rae", "Moss");
  const kai = await person(a, "kai-blocked", "Kai");
  const harbor = await company(a, "Harbor Labs", { domain: "harbor.example" });
  const quay = await company(a, "Quay Co", { linkedinUrl: "https://linkedin.com/company/quay-co" });

  const byId = await add(a, { kind: "person", personId: rae.id });
  const { id, createdAt, ...stored } = byId.body;
  assert.equal(byId.status, 201);
  assert.match(id, /^sup_/);
  assert.ok(Math.abs(Date.parse(createdAt) - Date.now()) < 60_000);
  assert.deepEqual(stored, {
    layer: "blocklist",
    matchType: "linkedin_url",
    linkedinUrl: "https://linkedin.com/in/rae-moss",
    domain: null,
    source: "manual",
    reason: null,
    createdBy: a.user.id,
    personId: rae.id,
    companyId: null,
    displayName: "Rae Moss",
  });
  const key = randomUUID();
  const value = "HTTPS://www.LinkedIn.com/in/Kai-Blocked/?utm=x";
  const byValue = await add(a, { kind: "person", value }, key);
  const companyById = await add(a, { kind: "company", companyId: harbor.id });
  const page = "https://www.linkedin.com/company/QUAY-CO/";
  const companyByValue = await add(a, { kind: "company", value: page });
  const domainOnly = await add(a, { kind: "company", value: "https://sub.nowhere.example/about" });
  const answers = [byValue, companyById, companyByValue, domainOnly];
  assert.deepEqual(
    answers.map(({ status, body }) => [status, body.matchType, body.linkedinUrl, body.domain]),
    [
      [201, "linkedin_url", "https://linkedin.com/in/kai-blocked", null],
      [201, "domain", null, "harbor.example"],
      [201, "linkedin_url", "https://linkedin.com/company/quay-co", null],
      [201, "domain", null, "sub.nowhere.example"],
    ],
  );

  const { status, body } = await call(a, "GET");
  assert.equal(status, 200);
  assert.deepEqual(
    body.entries.map((entry: Record<string, unknown>) => [
      entry.id,
      entry.personId,
      entry.companyId,
      entry.displayName,
    ]),
    [
      [domainOnly.body.id, null, null, null],
      [companyByValue.body.id, null, quay.id, "Quay Co"],
      [companyById.body.id, null, harbor.id, "Harbor Labs"],
      [byValue.body.id, kai.id, null, "Kai"],
      [id, rae.id, null, "Rae Moss"],
    ],
  );
  assert.equal(body.nextCursor, null);
  assert.ok(
    body.entries.every((entry: object) => !("hash" in entry)),
    "never the hash",
  );
  const first = await call(a, "GET", "?limit=2");
  const rest = await call(a, "GET", `?limit=3&cursor=${first.body.nextCursor}`);
  assert.deepEqual(
    [...first.body.entries, ...rest.body.entries].map((entry: { id: string }) => entry.id),
    body.entries.map((entry: { id: string }) => entry.id),
  );
  assert.equal(rest.body.nextCursor, null);

  // The same entry by another key, its key again: one row, one event each.
  const again = await add(a, { kind: "person", value: "https://linkedin.com/in/rae-moss" });
  assert.deepEqual([again.status, again.body], [201, byId.body]);
  const replay = await add(a, { kind: "person", value }, key);
  assert.deepEqual(replay, { ...byValue, replayed: "true" });
  const workspaceId = a.workspace.id;
  assert.equal(await asRole("app").suppressionEntry.count({ where: { workspaceId } }), 5);
  const where = { workspaceId, eventName: "contacts.suppression_added" };
  assert.equal(await asRole("app").outboxEntry.count({ where }), 5);
});

test("POST with layer opt_out records a person's opt-out by hand; DELETE removes a block, 204, and the list no longer has it; DELETE of the opt-out is 409 suppression_not_removable and it stays; an unknown or removed id is 404 suppression_not_found", async () => {
  const [a] = await createTwoWorkspaces();
  const ada = await person(a, "ada-opted-out", "Ada");
  const block = await add(a, { kind: "person", personId: ada.id });
  const optOut = await add(a, { kind: "person", personId: ada.id, layer: "opt_out" });
  assert.deepEqual(
    [optOut.status, optOut.body.layer, optOut.body.source, optOut.body.createdBy],
    [201, "opt_out", "manual", a.user.id],
  );
  const byUrl = await add(a, {
    kind: "person",
    value: "linkedin.com/in/nobody-yet",
    layer: "opt_out",
  });
  assert.deepEqual([byUrl.status, byUrl.body.personId], [201, null]);
  assert.deepEqual(await listed(a), [byUrl.body.id, optOut.body.id, block.body.id]);

  const removed = await call(a, "DELETE", `/${block.body.id}`);
  assert.deepEqual([removed.status, removed.body], [204, undefined]);
  assert.deepEqual(await listed(a), [byUrl.body.id, optOut.body.id]);
  const row = await asRole("app").suppressionEntry.findFirstOrThrow({
    where: { id: block.body.id },
  });
  assert.equal(row.removedBy, a.user.id);
  assert.ok(row.removedAt !== null);

  const notRemovable = { status: 409, body: { code: "suppression_not_removable" }, replayed: null };
  assert.deepEqual(await call(a, "DELETE", `/${optOut.body.id}`), notRemovable);
  const notFound = { status: 404, body: { code: "suppression_not_found" }, replayed: null };
  assert.deepEqual(await call(a, "DELETE", `/${block.body.id}`), notFound);
  assert.deepEqual(await call(a, "DELETE", "/sup_00000000000000000000000000"), notFound);
  assert.deepEqual(await listed(a), [byUrl.body.id, optOut.body.id]);
  // A block removed can be added again: a new entry.
  const reblocked = await add(a, { kind: "person", personId: ada.id });
  assert.deepEqual([reblocked.status, reblocked.body.id === block.body.id], [201, false]);
});

test("POST refuses invalid targets: 400 suppression_target_invalid for a value that normalizes to nothing, a single-label domain, a profile as a company or a company with neither domain nor page; 404 for an unknown person or company; 400 contacts_input_invalid for no target, two, or a company's opt-out; nothing is written", async () => {
  const [a] = await createTwoWorkspaces();
  const kai = await person(a, "kai-valid", "Kai");
  const workspaceId = a.workspace.id;
  const bare = await asRole("app").workspaceCompany.create({
    data: { id: "wco_bare1", workspaceId, name: "Bare", fieldProvenance: {} },
  });
  const harbor = await company(a, "Harbor", { domain: "harbor.example" });
  const refused = (status: number, code: string, details?: object) => ({
    status,
    body: details ? { code, details } : { code },
    replayed: null,
  });
  const cases = [
    [
      { kind: "person", value: "https://example.com/in/kai" },
      refused(400, "suppression_target_invalid"),
    ],
    [{ kind: "person", value: "" }, refused(400, "suppression_target_invalid")],
    [{ kind: "company", value: "localhost" }, refused(400, "suppression_target_invalid")],
    [{ kind: "company", value: "not a domain" }, refused(400, "suppression_target_invalid")],
    [
      { kind: "company", value: "https://linkedin.com/in/kai-valid" },
      refused(400, "suppression_target_invalid"),
    ],
    [{ kind: "company", companyId: bare.id }, refused(400, "suppression_target_invalid")],
    [
      { kind: "person", personId: "per_00000000000000000000000000" },
      refused(404, "person_not_found"),
    ],
    [
      { kind: "company", companyId: "wco_00000000000000000000000000" },
      refused(404, "company_not_found"),
    ],
    [{ kind: "person" }, refused(400, "contacts_input_invalid", { fields: ["personId", "value"] })],
    [
      { kind: "person", personId: kai.id, value: "https://linkedin.com/in/kai-valid" },
      refused(400, "contacts_input_invalid", { fields: ["personId", "value"] }),
    ],
    [
      { kind: "company", companyId: harbor.id, layer: "opt_out" },
      refused(400, "contacts_input_invalid", { fields: ["layer"] }),
    ],
    [
      { kind: "team", value: "harbor.example" },
      refused(400, "validation_failed", { fields: ["kind"] }),
    ],
  ] as const;
  for (const [body, answer] of cases)
    assert.deepEqual(await add(a, body), answer, JSON.stringify(body));
  const keyless = await call(a, "POST", "", { kind: "person", personId: kai.id }, { key: null });
  assert.deepEqual([keyless.status, keyless.body.code], [400, "idempotency_key_required"]);
  assert.equal(await asRole("app").suppressionEntry.count({ where: { workspaceId } }), 0);
});

test("a signed-in user who is no member of the workspace is 403 forbidden on the three routes; another workspace's entry is no entry of this one", async () => {
  const [a, b] = await createTwoWorkspaces();
  const theirs = await person(a, "lin-theirs", "Lin");
  const entry = (await add(a, { kind: "person", personId: theirs.id })).body;
  const nobody = await createUser();
  const forbidden = { status: 403, body: { code: "forbidden" }, replayed: null };
  const asNobody = { userId: nobody.id };
  assert.deepEqual(await call(a, "GET", "", undefined, asNobody), forbidden);
  const body = { kind: "person", personId: theirs.id };
  assert.deepEqual(await call(a, "POST", "", body, asNobody), forbidden);
  assert.deepEqual(await call(a, "DELETE", `/${entry.id}`, undefined, asNobody), forbidden);

  assert.deepEqual(await listed(b), []);
  const notFound = { status: 404, body: { code: "suppression_not_found" }, replayed: null };
  assert.deepEqual(await call(b, "DELETE", `/${entry.id}`), notFound);
  assert.deepEqual(await add(b, body), {
    status: 404,
    body: { code: "person_not_found" },
    replayed: null,
  });
  assert.deepEqual(await listed(a), [entry.id]);
});
