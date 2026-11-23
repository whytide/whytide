// playbooks' routes end to end (gamma-p3-040; core/modules/playbooks/README.md "Routes"): the host
// started with identity, icp and playbooks, on the fake authentication adapter, in a schema of the
// worktree's database, answering real HTTP; a write sends the app's Origin, a create an
// Idempotency-Key. The audiences are made through icp's route; the source checker is a fake put in
// place through playbooks' testing helper, or none. The events are read from the outbox. A member's
// removal is tenancy's removeMember, its event delivered as the worker delivers it, by one pass of
// the outbox through the subscribers the host loaded, playbooks' among them (gamma-p6-075); invited
// again is tenancy's addMember, as identity accepts an invite. The limits (limits-env,
// limits-no-max): the list answers the settings' defaults, and the OpenAPI document of icp's and
// playbooks' routes, built in a process of its own with the limits unset, set small and set large,
// is the same. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createOutboxStore, databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger, deliverPending, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { addMember, removeMember } from "@whytide/tenancy";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import type { ModuleLoader } from "../src/modules.ts";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

// icp and playbooks by their builds' paths, as icp-api.test.ts loads icp, and playbooks' testing
// helper from the same build, so that its fake checker is the one the routes ask.
const build = (path: string) => new URL(`../../../../modules/${path}`, import.meta.url).href;
type PlaybooksTesting = typeof import("../../../modules/playbooks/dist/testing/index.js");
type SourceChecker = NonNullable<Parameters<PlaybooksTesting["useSourceChecker"]>[0]>;
const testing: PlaybooksTesting = await import(build("playbooks/dist/testing/index.js"));
const db = withTestDb();
useTenancyClient(asRole("app"));
const modules: ModuleLoader[] = [
  { name: "identity", load: () => import("@whytide/identity") },
  { name: "icp", load: () => import(build("icp/dist/index.js")) },
  { name: "playbooks", load: () => import(build("playbooks/dist/index.js")) },
];
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules,
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

type Member = { readonly userId: string; readonly workspaceId: string; readonly cookie: string };
type Answer = { readonly status: number; readonly body: Record<string, unknown> };

/** The user, signed in, calling in the workspace. */
function signedIn(userId: string, workspaceId: string): Member {
  const cookie = signInAs(userId)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  return { userId, workspaceId, cookie };
}
/** The Owners of two new workspaces, each signed in. */
async function members(): Promise<[Member, Member]> {
  const [a, b] = await createTwoWorkspaces();
  return [signedIn(a.user.id, a.workspace.id), signedIn(b.user.id, b.workspace.id)];
}

/** A call to /v1/workspaces/:ws`path`; a write with the app's Origin, a create with `key`. */
async function request(who: Member, method: string, path: string, body?: object, key?: string) {
  const url = new URL(`/v1/workspaces/${who.workspaceId}${path}`, api.url);
  const idempotency = key === undefined ? {} : { "idempotency-key": key };
  const write = { origin: APP_ORIGIN, "content-type": "application/json", ...idempotency };
  const res = await fetch(url, {
    method,
    headers: { cookie: who.cookie, ...(method === "GET" ? {} : write) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
/** A call to …/playbooks`path`; a POST with a new Idempotency-Key unless one is given. */
const call = (who: Member, method: string, path: string, body?: object, key?: string) =>
  request(who, method, `/playbooks${path}`, body, method === "POST" ? (key ?? randomUUID()) : key);
const create = (who: Member, body: object, key?: string) => call(who, "POST", "", body, key);

/** A new audience of the member's workspace, through icp's route: its id. */
async function audience(who: Member, name: string): Promise<string> {
  const answer = await request(who, "POST", "/icp/audiences", { name });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  return String(answer.body.id);
}
/** A new agent of the member's on a new audience: its id and its audience's. */
async function agentOf(who: Member, name: string): Promise<{ id: string; icpId: string }> {
  const icpId = await audience(who, `${name}'s audience`);
  const answer = await create(who, { name, icpId });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  return { id: String(answer.body.id), icpId };
}

/** The payloads of `eventName` the workspace published, oldest first. */
async function published(workspaceId: string, eventName: string): Promise<unknown[]> {
  const where = { workspaceId, eventName };
  const rows = await asRole("app").outboxEntry.findMany({ where, orderBy: { id: "asc" } });
  return rows.map((row) => row.payload);
}
/** The list's limits with no setting given: the settings' defaults. */
const DEFAULT_LIMITS = { agents: 3, sources: 10 };
const refused = (status: number, code: string, details?: object) => ({
  status,
  body: details === undefined ? { code } : { code, details },
});

/** Sources of signals' form: read through the member's own account, another member's, none found. */
const mine = (n: number) => `src_mine${n}`;
const THEIRS = "src_theirs";
const GONE = "src_gone";
/** The fake checker of a test whose agents `owner` owns: GONE is left out, as one not found. */
const checker =
  (owner: string): SourceChecker =>
  async (sourceIds) =>
    sourceIds.flatMap((sourceId) => {
      if (sourceId === GONE) return [];
      const reader = sourceId === THEIRS ? "usr_another_member" : owner;
      return [
        { sourceId, found: true, readingAccountId: `sac_${reader}`, readingOwnerUserId: reader },
      ];
    });

test("POST …/playbooks is 201 with the agent, active, the caller its owner, no sources; its key's replay answers the same and makes none; GET lists it and reads it; PATCH renames, pauses and resumes; playbook_created once, playbook_updated per change", async () => {
  const [who] = await members();
  const icpId = await audience(who, "Logistics founders");
  const key = randomUUID();
  const created = await create(who, { name: "  Logistics agent ", icpId }, key);
  const { id, createdAt, ...made } = created.body;
  assert.equal(created.status, 201);
  assert.match(String(id), /^pbk_[0-9A-Z]{26}$/);
  assert.ok(!Number.isNaN(Date.parse(String(createdAt))), String(createdAt));
  const agent = {
    ...{ name: "Logistics agent", icpId, ownerUserId: who.userId },
    ...{ status: "active", pausedReason: null },
  };
  assert.deepEqual(made, { ...agent, sourceIds: [] });
  assert.deepEqual(await create(who, { name: "  Logistics agent ", icpId }, key), created);
  const listed = { ...agent, id, createdAt, sourceCount: 0 };
  const body = { playbooks: [listed], limits: DEFAULT_LIMITS };
  assert.deepEqual(await call(who, "GET", ""), { status: 200, body });
  assert.deepEqual(await call(who, "GET", `/${id}`), { status: 200, body: created.body });

  const patch = async (body: object) => (await call(who, "PATCH", `/${id}`, body)).body;
  assert.deepEqual(await patch({ name: " Renamed " }), { ...created.body, name: "Renamed" });
  assert.equal((await patch({ status: "paused" })).status, "paused");
  assert.equal((await patch({ status: "active" })).status, "active");
  const ownerUserId = who.userId;
  assert.deepEqual(await published(who.workspaceId, "playbooks.playbook_created"), [
    { playbookId: id, ownerUserId, icpId },
  ]);
  const statuses = ["active", "paused", "active"].map((status) => ({ playbookId: id, status }));
  assert.deepEqual(await published(who.workspaceId, "playbooks.playbook_updated"), statuses);
});

test("POST …/playbooks: 400 validation_failed for a blank name, one of 81 characters or no audience; 404 playbook_icp_not_found for another workspace's audience; 409 playbook_icp_in_use for one a live agent has; past three live agents, 409 playbook_limit_reached with the limit, also for two creates at once", async () => {
  const [who, them] = await members();
  const [a, b, c, d] = [
    await audience(who, "A"),
    await audience(who, "B"),
    await audience(who, "C"),
    await audience(who, "D"),
  ];
  const invalid = (field: string) => refused(400, "validation_failed", { fields: [field] });
  assert.deepEqual(await create(who, { name: "   ", icpId: a }), invalid("name"));
  assert.deepEqual(await create(who, { name: "x".repeat(81), icpId: a }), invalid("name"));
  assert.deepEqual(await create(who, { name: "No audience" }), invalid("icpId"));
  const theirs = await audience(them, "Theirs");
  const icpNotFound = refused(404, "playbook_icp_not_found");
  assert.deepEqual(await create(who, { name: "Theirs", icpId: theirs }), icpNotFound);

  assert.equal((await create(who, { name: "A", icpId: a })).status, 201);
  assert.deepEqual(
    await create(who, { name: "A again", icpId: a }),
    refused(409, "playbook_icp_in_use"),
  );
  assert.equal((await create(who, { name: "B", icpId: b })).status, 201);
  const racing = await Promise.all([
    create(who, { name: "C", icpId: c }),
    create(who, { name: "D", icpId: d }),
  ]);
  assert.deepEqual(racing.map((answer) => answer.status).sort(), [201, 409]);
  const limit = refused(409, "playbook_limit_reached", { limit: 3 });
  assert.deepEqual(
    racing.find((answer) => answer.status === 409),
    limit,
  );
  const listed = (await call(who, "GET", "")).body.playbooks as unknown[];
  assert.equal(listed.length, 3);
  assert.equal((await published(who.workspaceId, "playbooks.playbook_created")).length, 3);
});

test("PUT …/sources: with no checker, 503 playbook_source_checker_missing and nothing written; with one, the set replaced, a source not found, read through another member's account or held by another agent refused with its ids; GET …/sources/check answers each id; 400 past ten sources, fifty checked or off signals' form", async (t) => {
  const [who] = await members();
  const agent = await agentOf(who, "First");
  const other = await agentOf(who, "Second");
  const put = (id: string, sourceIds: string[]) =>
    call(who, "PUT", `/${id}/sources`, { sourceIds });
  const check = (id: string, ids: string[]) =>
    call(who, "GET", `/${id}/sources/check?ids=${ids.join(",")}`);
  const missing = refused(503, "playbook_source_checker_missing");
  assert.deepEqual(await put(agent.id, [mine(1)]), missing);
  assert.deepEqual(await check(agent.id, [mine(1)]), missing);
  assert.deepEqual((await call(who, "GET", `/${agent.id}`)).body.sourceIds, []);

  t.after(testing.useSourceChecker(checker(who.userId)));
  const set = await put(agent.id, [mine(2), mine(1)]);
  assert.deepEqual([set.status, set.body.sourceIds], [200, [mine(1), mine(2)]]);
  const notFound = refused(409, "playbook_source_not_found", { sourceIds: [GONE] });
  assert.deepEqual(await put(agent.id, [GONE, mine(1)]), notFound);
  const wrongOwner = refused(409, "playbook_source_wrong_owner", { sourceIds: [THEIRS] });
  assert.deepEqual(await put(agent.id, [THEIRS]), wrongOwner);
  const inUse = refused(409, "playbook_source_in_use", { sourceIds: [mine(1)] });
  assert.deepEqual(await put(other.id, [mine(3), mine(1)]), inUse);
  assert.deepEqual((await call(who, "GET", `/${other.id}`)).body.sourceIds, []);
  assert.deepEqual(await check(other.id, [mine(3), mine(1), THEIRS, GONE]), {
    status: 200,
    body: {
      sources: [
        { sourceId: mine(3), usable: true, code: null, heldBy: null },
        { sourceId: mine(1), usable: false, code: "playbook_source_in_use", heldBy: agent.id },
        { sourceId: THEIRS, usable: false, code: "playbook_source_wrong_owner", heldBy: null },
        { sourceId: GONE, usable: false, code: "playbook_source_not_found", heldBy: null },
      ],
    },
  });
  assert.deepEqual(await check(other.id, []), { status: 200, body: { sources: [] } });
  const listed = (await call(who, "GET", "")).body.playbooks as { sourceCount: number }[];
  assert.deepEqual(
    listed.map((playbook) => playbook.sourceCount),
    [2, 0],
  );
  assert.deepEqual(await published(who.workspaceId, "playbooks.sources_changed"), [
    { playbookId: agent.id },
  ]);

  const ten = Array.from({ length: 10 }, (_, n) => mine(n));
  assert.equal((await put(other.id, ten.slice(3))).status, 200);
  const invalid = (field: string) => refused(400, "validation_failed", { fields: [field] });
  // Past the setting, the domain's own code (limits-env), however many: the schema caps no set
  // (limits-no-max); the check route still reads at most 50 ids.
  const sourcesLimit = refused(400, "playbook_sources_limit", { limit: 10 });
  assert.deepEqual(await put(other.id, [...ten, mine(10)]), sourcesLimit);
  assert.deepEqual(await put(other.id, ["src_not-one"]), invalid("sourceIds.0"));
  const fiftyOne = Array.from({ length: 51 }, (_, n) => mine(n));
  assert.deepEqual(await put(other.id, fiftyOne), sourcesLimit);
  assert.deepEqual(await check(other.id, fiftyOne), invalid("ids"));
  assert.deepEqual(await check(other.id, [mine(1), "pbk_x"]), invalid("ids"));
});

test("PATCH …/playbooks/:id to archived frees its sources and its audience and is final: every later change is 409 playbook_archived; the list shows the live agents first", async (t) => {
  const [who] = await members();
  t.after(testing.useSourceChecker(checker(who.userId)));
  const agent = await agentOf(who, "Archived");
  assert.equal(
    (await call(who, "PUT", `/${agent.id}/sources`, { sourceIds: [mine(1)] })).status,
    200,
  );
  const archived = await call(who, "PATCH", `/${agent.id}`, { status: "archived" });
  assert.deepEqual(
    [archived.status, archived.body.status, archived.body.sourceIds],
    [200, "archived", []],
  );
  const changes: [string, string, object][] = [
    ["PATCH", `/${agent.id}`, { status: "active" }],
    ["PATCH", `/${agent.id}`, { name: "Again" }],
    ["PUT", `/${agent.id}/sources`, { sourceIds: [] }],
  ];
  for (const [method, path, body] of changes) {
    assert.deepEqual(await call(who, method, path, body), refused(409, "playbook_archived"), path);
  }
  const next = await create(who, { name: "Next", icpId: agent.icpId });
  assert.equal(next.status, 201, "the audience is free");
  const linked = await call(who, "PUT", `/${String(next.body.id)}/sources`, {
    sourceIds: [mine(1)],
  });
  assert.deepEqual(linked.body.sourceIds, [mine(1)], "the source is free");
  const listed = (await call(who, "GET", "")).body.playbooks as Record<string, unknown>[];
  assert.deepEqual(
    listed.map((playbook) => [playbook.id, playbook.status]),
    [
      [next.body.id, "active"],
      [agent.id, "archived"],
    ],
  );
});

test("another workspace's agent is 404 playbook_not_found on every route that names one; it is not listed and stays as it was", async (t) => {
  const [who, them] = await members();
  t.after(testing.useSourceChecker(checker(them.userId)));
  const theirs = await agentOf(them, "Theirs");
  const calls: [string, string, object?][] = [
    ["GET", `/${theirs.id}`],
    ["PATCH", `/${theirs.id}`, { status: "archived" }],
    ["PUT", `/${theirs.id}/sources`, { sourceIds: [mine(1)] }],
    ["GET", `/${theirs.id}/sources/check?ids=${mine(1)}`],
  ];
  for (const [method, path, body] of calls) {
    const answer = await call(who, method, path, body);
    assert.deepEqual(answer, refused(404, "playbook_not_found"), `${method} ${path}`);
  }
  const body = { playbooks: [], limits: DEFAULT_LIMITS };
  assert.deepEqual(await call(who, "GET", ""), { status: 200, body });
  const kept = (await call(them, "GET", `/${theirs.id}`)).body;
  assert.deepEqual([kept.status, kept.sourceIds], ["active", []]);
  assert.deepEqual(await published(them.workspaceId, "playbooks.playbook_updated"), []);
});

test("an agent whose owner left (gamma-p6-075): the removal's delivery pauses it member_removed; an Owner's resume is 409 playbook_owner_removed, also with a rename, nothing changed and no event, a pause keeping the reason; the removed owner is refused; the owner, a member again, resumes it; a pause through the PATCH records user", async () => {
  const [owner] = await members();
  const ws = owner.workspaceId;
  const user = await createUser();
  const membership = await createMembership({ userId: user.id, workspaceId: ws, role: "Member" });
  const member = signedIn(user.id, ws);
  const icpId = await audience(owner, "Her audience");
  const created = await create(member, { name: "Her agent", icpId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = String(created.body.id);
  const app = asRole("app");
  const worker = servicePrincipal("worker");
  const removal = { membershipId: membership.id, removedBy: owner.userId };
  await withTenant({ workspaceId: ws, principal: worker }, () => removeMember(removal), {
    client: app,
  });
  const report = await deliverPending({
    store: createOutboxStore(app),
    runInTenant: (workspaceId, fn) =>
      withTenant({ workspaceId, principal: worker }, fn, { client: app }),
    log: createLogger({ destination: collectLogs().destination }),
  });
  assert.deepEqual([report.retried, report.dead], [0, 0], "every event delivered");

  const read = await call(owner, "GET", `/${id}`);
  assert.deepEqual([read.body.status, read.body.pausedReason], ["paused", "member_removed"]);
  const ownerRemoved = refused(409, "playbook_owner_removed");
  assert.deepEqual(await call(owner, "PATCH", `/${id}`, { status: "active" }), ownerRemoved);
  const renamed = { status: "active", name: "Taken over" };
  assert.deepEqual(await call(owner, "PATCH", `/${id}`, renamed), ownerRemoved);
  assert.deepEqual(await call(owner, "GET", `/${id}`), read, "nothing changed");
  const pausedAgain = await call(owner, "PATCH", `/${id}`, { status: "paused" });
  assert.deepEqual(pausedAgain, read, "a pause keeps the removal's reason");
  const removed = await call(member, "PATCH", `/${id}`, { status: "active" });
  assert.deepEqual(removed, refused(403, "forbidden"), "a removed member reaches no route");

  await addMember({ userId: user.id, workspaceId: ws, role: "Member" });
  const resumed = await call(member, "PATCH", `/${id}`, { status: "active" });
  assert.deepEqual(
    [resumed.status, resumed.body.status, resumed.body.pausedReason],
    [200, "active", null],
  );
  const paused = await call(member, "PATCH", `/${id}`, { status: "paused" });
  assert.deepEqual(
    [paused.status, paused.body.status, paused.body.pausedReason],
    [200, "paused", "user"],
  );
  const statuses = ["paused", "active", "paused"].map((status) => ({ playbookId: id, status }));
  assert.deepEqual(await published(ws, "playbooks.playbook_updated"), statuses);
});

test("the OpenAPI document of icp's and playbooks' routes is the same with the three limits unset, set small and set large: no schema or summary reads them; the PUT of sources caps no set", () => {
  const names = [
    "PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE",
    "PLAYBOOKS_MAX_SOURCES_PER_AGENT",
    "ICP_MAX_AUDIENCES_PER_WORKSPACE",
  ];
  const href = (path: string) => JSON.stringify(build(path));
  /** The document a process with `set` builds, and the limits it read: openapi:build's own steps. */
  const built = (set: Record<string, string>) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...set };
    for (const name of names) if (!(name in set)) delete env[name];
    const script = [
      `const { apiCallFiles, buildOpenApi } = await import(${JSON.stringify(new URL("../openapi/build.js", import.meta.url).href)});`,
      "const modules = [",
      `  { name: "icp", load: () => import(${href("icp/dist/index.js")}) },`,
      `  { name: "playbooks", load: () => import(${href("playbooks/dist/index.js")}) },`,
      "];",
      "const document = await buildOpenApi({ modules, httpFiles: apiCallFiles() });",
      `const icp = (await import(${href("icp/dist/settings.js")})).settings;`,
      `const playbooks = (await import(${href("playbooks/dist/settings.js")})).settings;`,
      "const limits = [playbooks.PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE, playbooks.PLAYBOOKS_MAX_SOURCES_PER_AGENT, icp.ICP_MAX_AUDIENCES_PER_WORKSPACE];",
      "process.stdout.write(JSON.stringify({ limits, document: JSON.stringify(document) }));",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env,
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as { limits: number[]; document: string };
  };
  const unset = built({});
  const set = built({
    PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE: "4",
    PLAYBOOKS_MAX_SOURCES_PER_AGENT: "2",
    ICP_MAX_AUDIENCES_PER_WORKSPACE: "3",
  });
  const large = built({
    PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE: "1000",
    PLAYBOOKS_MAX_SOURCES_PER_AGENT: "1000",
    ICP_MAX_AUDIENCES_PER_WORKSPACE: "1000",
  });
  assert.deepEqual(
    [unset.limits, set.limits, large.limits],
    [
      [3, 10, 10],
      [4, 2, 3],
      [1000, 1000, 1000],
    ],
  );
  assert.equal(set.document, unset.document);
  assert.equal(large.document, unset.document);
  const sources = JSON.parse(unset.document).paths[
    "/v1/workspaces/{workspaceId}/playbooks/{playbookId}/sources"
  ].put.requestBody.content["application/json"].schema.properties.sourceIds;
  assert.equal(sources.maxItems, undefined);
});

// env-settings-a: the eleven settings of campaigns, contacts, approvals, inbox and linkedin, read
// the same way as the limits above: the document of those five modules' routes, built in a process
// of its own, is the same unset, set to their least and set large. The campaign answer's limits and
// the refusal's days carry the value; the schemas name the defaults only.
test("the OpenAPI document of campaigns', contacts', approvals', inbox's and linkedin's routes is the same with their eleven settings unset, set to their least and set large: no schema or summary reads them", () => {
  /** Each module's build, the export its settings sit in, and the settings it reads. */
  const read = {
    campaigns: [
      "settings",
      "CAMPAIGNS_MAX_STEP_DELAY_BUSINESS_DAYS",
      "CAMPAIGNS_NOT_INTERESTED_COOL_DOWN_DAYS",
      "CAMPAIGNS_NOT_NOW_REMINDER_DAYS",
      "CAMPAIGNS_OOO_DEFAULT_PAUSE_DAYS",
      "CAMPAIGNS_OOO_RESUME_BUSINESS_DAYS",
    ],
    contacts: ["touchSettings", "CONTACTS_RECENT_TOUCH_DAYS"],
    approvals: [
      "settings",
      "APPROVALS_NEEDS_ATTENTION_AFTER_DAYS",
      "APPROVALS_QUEUE_WINDOW_HOURS",
      "APPROVALS_SMALL_EDIT_MAX_RATIO",
    ],
    inbox: ["settings", "INBOX_CLASSIFY_SUGGEST_BELOW"],
    linkedin: ["noteSettings", "LINKEDIN_INVITE_NOTES_PER_MONTH"],
  };
  const names = Object.values(read).flatMap(([, ...settings]) => settings);
  const href = (path: string) => JSON.stringify(build(path));
  /** The document a process with `set` builds, and the settings it read: openapi:build's own steps. */
  const built = (set: Record<string, string>) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...set };
    for (const name of names) if (!(name in set)) delete env[name];
    const modules = Object.keys(read).map(
      (name) => `  { name: "${name}", load: () => import(${href(`${name}/dist/index.js`)}) },`,
    );
    const values = Object.entries(read).map(
      ([name, [exported, ...settings]]) =>
        `  [${href(`${name}/dist/settings.js`)}, "${exported}", ${JSON.stringify(settings)}],`,
    );
    const script = [
      `const { apiCallFiles, buildOpenApi } = await import(${JSON.stringify(new URL("../openapi/build.js", import.meta.url).href)});`,
      "const modules = [",
      ...modules,
      "];",
      "const document = await buildOpenApi({ modules, httpFiles: apiCallFiles() });",
      "const blocks = [",
      ...values,
      "];",
      "const settings = [];",
      "for (const [path, exported, names] of blocks) {",
      "  const block = (await import(path))[exported];",
      "  settings.push(...names.map((name) => block[name]));",
      "}",
      "process.stdout.write(JSON.stringify({ settings, document: JSON.stringify(document) }));",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env,
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as { settings: number[]; document: string };
  };
  const unset = built({});
  const least = [5, 1, 1, 1, 0, 1, 1, 1, 0.01, 0.01, 1];
  const set = built(Object.fromEntries(names.map((name, i) => [name, String(least[i])])));
  const large = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1, 1, 1000];
  const setLarge = built(Object.fromEntries(names.map((name, i) => [name, String(large[i])])));
  assert.deepEqual(
    [unset.settings, set.settings, setLarge.settings],
    [[30, 180, 30, 7, 1, 90, 3, 24, 0.2, 0.7, 3], least, large],
  );
  assert.equal(set.document, unset.document);
  assert.equal(setLarge.document, unset.document);
  const campaign = JSON.parse(unset.document).paths[
    "/v1/workspaces/{workspaceId}/campaigns/{campaignId}"
  ];
  assert.ok(campaign.get, "the campaign's GET is in the document");
});
