// signals' Companies found routes end to end (gamma-wr-110; core/modules/signals README.md "API"): the host
// started with identity's guard and the signals and playbooks modules, on the fake authentication
// adapter, in a schema of the worktree's database, answering real HTTP. GET …/signals/found-companies is
// the list (the fit and unsure ones, newest judged first, filtered by source, agent and verdict, in pages),
// POST …/found-companies/{id}/not-fit marks one Not a fit (the source's creator or a holder of
// signals.manage), GET …/found-companies/export.csv is the view as a file for those who hold contacts'
// exports.read. It lives here: a module never imports a host. Two made-up businesses in two countries.
import assert from "node:assert/strict";
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
  type TestTenant,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

const build = new URL("../../../../modules/signals/dist/", import.meta.url);
type SignalsTesting = typeof import("../../../modules/signals/dist/testing/index.js");
type PlaybooksTesting = typeof import("../../../modules/playbooks/dist/testing/index.js");
const testing: SignalsTesting = await import(new URL("testing/index.js", build).href);
const playbooksBuild = new URL("../../playbooks/dist/", build);
const { createPlaybook }: PlaybooksTesting = await import(
  new URL("testing/index.js", playbooksBuild).href
);
const { createFoundCompany, createSignalSource, useSignalsClient } = testing;

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
useSignalsClient(asRole("app"));
const logs = collectLogs();
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: logs.destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "signals", load: () => import(new URL("index.js", build).href) },
      { name: "playbooks", load: () => import(new URL("index.js", playbooksBuild).href) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

type Answer = { status: number; body: any };
const cookieOf = (userId: string) =>
  signInAs(userId)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");

/** A call to …/signals/found-companies<path> in the tenant's workspace as the user, its Owner unless named. */
async function call(
  tenant: TestTenant,
  method: string,
  path = "",
  userId = tenant.user.id,
): Promise<Answer & { type: string | null; disposition: string | null }> {
  const headers = { cookie: cookieOf(userId), "sec-fetch-site": "same-origin" };
  const url = new URL(
    `/v1/workspaces/${tenant.workspace.id}/signals/found-companies${path}`,
    api.url,
  );
  const res = await fetch(url, { method, headers });
  // Read as bytes: text() drops a byte-order mark, which the file must start with.
  const text = Buffer.from(await res.arrayBuffer()).toString("utf8");
  const csv = (res.headers.get("content-type") ?? "").startsWith("text/csv");
  return {
    status: res.status,
    body: csv ? text : text ? JSON.parse(text) : undefined,
    type: res.headers.get("content-type"),
    disposition: res.headers.get("content-disposition"),
  };
}

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.UTC(2026, 10, 1) + days * DAY);
const reason = {
  ...{ kind: "focus", answer: "shown", line: "Sells cold rooms to restaurants." },
  ...{ quote: "vende câmaras frigoríficas", url: "https://aurora-frio.example/" },
  readAt: at(0).toISOString(),
};

/** Two sources, the first its Owner's and the second a Member's, and their companies. */
async function world() {
  const [a, b] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId, role: "Member" });
  const config = { focus: "cold rooms for restaurants", languages: ["pt"] };
  const made = (label: string, createdBy: string) =>
    createSignalSource({
      ...{ workspaceId, label, kind: "web_research", config, createdBy, senderAccountId: null },
    });
  const owners = await made("Cold rooms Brazil", a.user.id);
  const members = await made("Roasters Germany", member.id);
  const company = (sourceId: string, domain: string, over: object = {}) =>
    createFoundCompany({ workspaceId, sourceId, domain, sourceLabel: "kept", ...over });
  const aurora = await company(owners.id, "aurora-frio.example", {
    ...{ name: "=Aurora Frio Ltda", verdict: "fit", judgedAt: at(3), reasons: [reason] },
    ...{
      country: "BR",
      town: "São Paulo",
      placeId: "fair_exhibitors",
      email: "info@aurora.example",
    },
    ...{ pageUrl: "https://fair.example/list", phones: ["+55 11 4002 8922"] },
  });
  const brandt = await company(members.id, "brandt-roesterei.example", {
    ...{ name: "Rösterei Brandt", verdict: "unsure", judgedAt: at(2) },
  });
  const klein = await company(members.id, "klein-werk.example", {
    ...{ name: "Klein Werk", verdict: "not_fit", judgedAt: at(1) },
  });
  return { a, b, member, owners, members, aurora, brandt, klein, workspaceId };
}
const ids = (body: { companies: { id: string }[] }) => body.companies.map(({ id }) => id);

test("GET …/found-companies: the fit and unsure companies newest first with their reasons, the page that led to each and its source type, how to reach it and the source's label; the verdict, source and agent filters; pages by a cursor; a bad verdict or limit 400; a Member reads; another workspace's user, no member, 403 and workspace B sees none", async () => {
  const w = await world();
  const listed = await call(w.a, "GET");
  assert.equal(listed.status, 200);
  assert.deepEqual(ids(listed.body), [w.aurora.id, w.brandt.id]);
  assert.equal(listed.body.nextCursor, null);
  assert.deepEqual(listed.body.companies[0], {
    ...{ id: w.aurora.id, sourceId: w.owners.id, sourceLabel: "Cold rooms Brazil" },
    ...{ name: "=Aurora Frio Ltda", domain: "aurora-frio.example" },
    ...{ website: "https://aurora-frio.example/", verdict: "fit" },
    ...{ markedByMember: false, markedBy: null, markedAt: null, reasons: [reason] },
    ...{ country: "BR", town: "São Paulo", state: null },
    ...{ pageUrl: "https://fair.example/list", placeId: "fair_exhibitors" },
    ...{ email: "info@aurora.example", phones: ["+55 11 4002 8922"], postalAddress: null },
    ...{ judgedAt: at(3).toISOString(), leads: [], leadCount: 0 },
  });
  const notFit = await call(w.a, "GET", "?verdict=not_fit");
  assert.deepEqual(ids(notFit.body), [w.klein.id]);
  const bySource = await call(w.a, "GET", `?sourceId=${w.members.id}`);
  assert.deepEqual(ids(bySource.body), [w.brandt.id]);
  const agent = await createPlaybook({
    ...{ workspaceId: w.workspaceId, icpId: "icp_agent", ownerUserId: w.a.user.id },
    ...{ name: "Agent", sourceIds: [w.owners.id] },
  });
  const byAgent = await call(w.a, "GET", `?playbookId=${agent}`);
  assert.deepEqual(ids(byAgent.body), [w.aurora.id]);
  const paged = await call(w.a, "GET", "?limit=1");
  assert.deepEqual([ids(paged.body), typeof paged.body.nextCursor], [[w.aurora.id], "string"]);
  const next = await call(w.a, "GET", `?limit=1&cursor=${paged.body.nextCursor}`);
  assert.deepEqual([ids(next.body), next.body.nextCursor], [[w.brandt.id], null]);
  assert.equal((await call(w.a, "GET", "?verdict=maybe")).status, 400);
  assert.equal((await call(w.a, "GET", "?limit=0")).status, 400);
  assert.equal((await call(w.a, "GET", "?limit=101")).status, 400);
  assert.equal((await call(w.a, "GET", "", w.member.id)).status, 200);
  const outsider = await createUser();
  assert.deepEqual((await call(w.a, "GET", "", outsider.id)).body, { code: "forbidden" });
  assert.deepEqual((await call(w.b, "GET")).body, { companies: [], nextCursor: null });
  assert.deepEqual((await call(w.b, "GET", `?sourceId=${w.owners.id}`)).body.companies, []);
});

test("POST …/found-companies/{id}/not-fit: 200 with the company not_fit, the member's, with who and when; a second mark changes nothing; the source's creator and an Owner may, another Member is 403 and nothing is written; an unknown id and another workspace's company 404 signal_found_company_not_found; no member 403", async () => {
  const w = await world();
  const marked = await call(w.a, "POST", `/${w.aurora.id}/not-fit`);
  assert.equal(marked.status, 200);
  assert.deepEqual(
    [marked.body.verdict, marked.body.markedByMember, marked.body.markedBy],
    ["not_fit", true, w.a.user.id],
  );
  const { markedAt } = marked.body;
  assert.ok(markedAt && !Number.isNaN(Date.parse(markedAt)));
  assert.deepEqual(ids((await call(w.a, "GET")).body), [w.brandt.id]);
  assert.deepEqual(
    ids((await call(w.a, "GET", "?verdict=not_fit")).body).sort(),
    [w.aurora.id, w.klein.id].sort(),
  );
  // The same call again changes nothing: the first mark's who and when stay.
  const again = await call(w.a, "POST", `/${w.aurora.id}/not-fit`);
  assert.deepEqual(
    [again.status, again.body.markedBy, again.body.markedAt],
    [200, w.a.user.id, markedAt],
  );
  // A Member marks a company of their own source, and not the Owner's.
  const forbidden = { status: 403, body: { code: "forbidden" } };
  const refused = await call(w.a, "POST", `/${w.brandt.id}/not-fit`, w.a.user.id);
  assert.equal(refused.status, 200, "an Owner holds signals.manage and marks any");
  const own = await createFoundCompany({
    ...{ workspaceId: w.workspaceId, sourceId: w.members.id, domain: "member-own.example" },
    name: "Member Own",
  });
  const theirs = await call(w.a, "POST", `/${own.id}/not-fit`, w.member.id);
  assert.deepEqual([theirs.status, theirs.body.markedBy], [200, w.member.id]);
  const other = await createFoundCompany({
    ...{ workspaceId: w.workspaceId, sourceId: w.owners.id, domain: "owner-own.example" },
    name: "Owner Own",
  });
  const denied = await call(w.a, "POST", `/${other.id}/not-fit`, w.member.id);
  assert.deepEqual({ status: denied.status, body: denied.body }, forbidden);
  const row = await asRole("app").signalFoundCompany.findUniqueOrThrow({ where: { id: other.id } });
  assert.deepEqual([row.verdict, row.memberMark, row.memberMarkedBy], ["fit", null, null]);
  const notFound = { status: 404, body: { code: "signal_found_company_not_found" } };
  const unknown = await call(w.a, "POST", "/fco_unknown/not-fit");
  assert.deepEqual({ status: unknown.status, body: unknown.body }, notFound);
  const across = await call(w.b, "POST", `/${w.klein.id}/not-fit`);
  assert.deepEqual({ status: across.status, body: across.body }, notFound);
  const outsider = await createUser();
  assert.equal((await call(w.a, "POST", `/${w.klein.id}/not-fit`, outsider.id)).status, 403);
});

test("GET …/found-companies/export.csv: text/csv with a byte-order mark and the header, the list's view by its filters, a cell that starts with = neutralized as contacts' CSV writes it, the company's own address and phones; a Member, who holds no exports.read, and another workspace's user, no member, are 403; workspace B's file holds none of A's companies", async () => {
  const w = await world();
  const file = await call(w.a, "GET", "/export.csv");
  assert.equal(file.status, 200);
  assert.equal(file.type, "text/csv; charset=utf-8");
  assert.match(
    file.disposition ?? "",
    /^attachment; filename="companies-found-\d{4}-\d{2}-\d{2}\.csv"$/,
  );
  const lines = (file.body as string).split("\r\n");
  assert.ok(lines[0]?.startsWith("\uFEFFcompany,website,verdict,"));
  assert.equal(lines.length, 4, "the header, the fit and the unsure company, the final break");
  assert.ok(lines[1]?.startsWith("'=Aurora Frio Ltda,https://aurora-frio.example/,fit,no,BR,"));
  assert.ok(lines[1]?.includes("info@aurora.example,'+55 11 4002 8922,"));
  assert.ok(lines[2]?.startsWith("R\u00f6sterei Brandt,"));
  const notFit = await call(w.a, "GET", "/export.csv?verdict=not_fit");
  assert.equal((notFit.body as string).split("\r\n").length, 3);
  const byAgent = await call(w.a, "GET", `/export.csv?sourceId=${w.members.id}`);
  assert.ok(!(byAgent.body as string).includes("Aurora"));
  assert.deepEqual((await call(w.a, "GET", "/export.csv", w.member.id)).body, {
    code: "forbidden",
  });
  const outsider = await createUser();
  assert.equal((await call(w.a, "GET", "/export.csv", outsider.id)).status, 403);
  const b = await call(w.b, "GET", "/export.csv");
  assert.equal((b.body as string).split("\r\n").length, 2);
});
