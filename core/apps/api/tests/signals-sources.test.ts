// signals' sources routes end to end (alpha-p8-010, alpha-p8-020, fix-run-stop, gamma-p5-040,
// gamma-p5-045; core/modules/signals README.md "API"): the host started with identity's guard and the
// signals and playbooks modules, on the fake authentication adapter, in a schema of the worktree's
// database, answering real HTTP; playbooks' sources route asks signals' own source checker. It lives
// here: a module never imports a host. A source's sender account is a connected account of its
// workspace, written by linkedin's test factory; an agent is written by playbooks'. A short link's
// request is signals' shortLinks.get, mocked: no test leaves the laptop.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import {
  AppError,
  collectLogs,
  createLogger,
  type FetchSafeResponse,
  newId,
  servicePrincipal,
} from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createTwoWorkspaces,
  createUser,
  type TestTenant,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

// signals and playbooks, and linkedin's and playbooks' test hooks, by their builds' paths, as
// src/modules.generated.ts loads them: the api does not list a module with a screen
// (core/apps/web/docs/screens.md).
const build = new URL("../../../../modules/signals/dist/", import.meta.url);
type SignalsTesting = typeof import("../../../modules/signals/dist/testing/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
type Playbooks = typeof import("../../../modules/playbooks/dist/index.js");
type PlaybooksTesting = typeof import("../../../modules/playbooks/dist/testing/index.js");
const testing: SignalsTesting = await import(new URL("testing/index.js", build).href);
const linkedin: LinkedinTesting = await import(
  new URL("../../linkedin/dist/testing/index.js", build).href
);
const playbooksBuild = new URL("../../playbooks/dist/", build);
const playbooks: Playbooks = await import(new URL("index.js", playbooksBuild).href);
const { createPlaybook }: PlaybooksTesting = await import(
  new URL("testing/index.js", playbooksBuild).href
);
const { createResearchPlan, createSignalRun, createSignalSource, shortLinks, useSignalsClient } =
  testing;

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
linkedin.useLinkedinClient(asRole("app"));
useSignalsClient(asRole("app"));
const POST_URL =
  "https://www.linkedin.com/posts/example-author_launch-day-activity-7250000000000000000-AbCd";
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

const cookieOf = (tenant: TestTenant) =>
  signInAs(tenant.user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");

/** A call to …/signals/sources<path> in the tenant's workspace, as its Owner, from the app. */
async function call(
  tenant: TestTenant,
  method: string,
  path = "",
  body?: unknown,
): Promise<Answer> {
  const headers: Record<string, string> = {
    cookie: cookieOf(tenant),
    "sec-fetch-site": "same-origin",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const url = new URL(`/v1/workspaces/${tenant.workspace.id}/signals/sources${path}`, api.url);
  const json = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, { method, headers, body: json });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/** POST …/sources/<id>/run in the tenant's workspace under the Idempotency-Key `key`, when given. */
async function runNow(
  tenant: TestTenant,
  sourceId: string,
  key?: string,
): Promise<Answer & { replayed: string | null }> {
  const headers: Record<string, string> = {
    cookie: cookieOf(tenant),
    "sec-fetch-site": "same-origin",
  };
  if (key !== undefined) headers["idempotency-key"] = key;
  const path = `/v1/workspaces/${tenant.workspace.id}/signals/sources/${sourceId}/run`;
  const res = await fetch(new URL(path, api.url), { method: "POST", headers });
  return {
    status: res.status,
    replayed: res.headers.get("idempotent-replayed"),
    body: await res.json(),
  };
}

/**
 * POST …/sources/<id>/runs/<runId>/stop in the tenant's workspace under the Idempotency-Key `key`, as
 * the user, the tenant's Owner unless named.
 */
async function stop(
  tenant: TestTenant,
  sourceId: string,
  runId: string,
  key = randomUUID(),
  userId = tenant.user.id,
): Promise<Answer & { replayed: string | null }> {
  const headers = {
    cookie: signInAs(userId)
      .map(({ name, value }) => `${name}=${value}`)
      .join("; "),
    "sec-fetch-site": "same-origin",
    "idempotency-key": key,
  };
  const path = `/v1/workspaces/${tenant.workspace.id}/signals/sources/${sourceId}/runs/${runId}/stop`;
  const res = await fetch(new URL(path, api.url), { method: "POST", headers });
  return {
    status: res.status,
    replayed: res.headers.get("idempotent-replayed"),
    body: await res.json(),
  };
}

/** A connected sender account of the tenant's workspace, of its own owner unless one is named. */
const senderOf = async (tenant: TestTenant, ownerUserId?: string) =>
  (await linkedin.createConnectedAccount(tenant.workspace.id, ownerUserId ? { ownerUserId } : {}))
    .id;

/** A call to …/playbooks<path> in the tenant's workspace, as its Owner, from the app. */
async function agents(tenant: TestTenant, method: string, path: string, body?: unknown) {
  const headers = { cookie: cookieOf(tenant), "sec-fetch-site": "same-origin" };
  const url = new URL(`/v1/workspaces/${tenant.workspace.id}/playbooks${path}`, api.url);
  const json = body === undefined ? {} : { body: JSON.stringify(body) };
  const type = body === undefined ? {} : { "content-type": "application/json" };
  const res = await fetch(url, { method, headers: { ...headers, ...type }, ...json });
  return { status: res.status, body: await res.json() } as Answer;
}

/** An agent of the tenant's Owner, written by playbooks' factory, holding these sources: its id. */
const agentOf = (tenant: TestTenant, name: string, sourceIds: readonly string[] = []) =>
  createPlaybook({
    ...{ workspaceId: tenant.workspace.id, icpId: `icp_${name.replaceAll(" ", "_")}` },
    ...{ ownerUserId: tenant.user.id, name, sourceIds },
  });

/** `n` post sources on the account written to the table, enabled unless said: their ids. */
async function seeded(tenant: TestTenant, senderAccountId: string, n: number, enabled = true) {
  const ids: string[] = [];
  for (let at = 0; at < n; at++) {
    const source = await asRole("app").signalSource.create({
      data: {
        id: newId("src"),
        ...{
          workspaceId: tenant.workspace.id,
          kind: "post_engagers",
          config: { postUrl: POST_URL },
        },
        ...{ label: `Seeded ${at + 1}`, senderAccountId, enabled, createdBy: tenant.user.id },
      },
    });
    ids.push(source.id);
  }
  return ids;
}

const newSource = (senderAccountId: string, label = "Launch post") => ({
  kind: "post_engagers",
  config: { postUrl: POST_URL },
  label,
  senderAccountId,
});

test("POST a post_engagers source: 201 with the row and its three next fire times; an unknown kind 400 signal_kind_unknown; a non-post URL 400 signal_config_invalid naming config.postUrl", async () => {
  const [a] = await createTwoWorkspaces();
  const sender = await senderOf(a);
  const created = await call(a, "POST", "", newSource(sender));
  assert.equal(created.status, 201);
  const { id, createdAt } = created.body;
  const row = await asRole("app").signalSource.findUniqueOrThrow({ where: { id } });
  const saved = row.createdAt.getTime();
  const fireTimes = [0, 3, 7].map((days) => new Date(saved + days * 86_400_000).toISOString());
  assert.deepEqual(created.body, {
    id,
    kind: "post_engagers",
    config: { postUrl: POST_URL },
    label: "Launch post",
    senderAccountId: sender,
    enabled: true,
    createdBy: a.user.id,
    createdAt: row.createdAt.toISOString(),
    lastRunAt: null,
    fireTimes,
    nextRunAt: fireTimes[0],
    runOpen: false,
    openRun: null,
    cadence: null,
    everyDays: null,
    lastRunBudgetReached: false,
    sourceImport: null,
    playbook: null,
  });
  assert.deepEqual([row.workspaceId, createdAt], [a.workspace.id, row.createdAt.toISOString()]);
  assert.deepEqual(await call(a, "GET"), { status: 200, body: { sources: [created.body] } });

  const unknown = await call(a, "POST", "", { ...newSource(sender), kind: "job_board" });
  const fields = (field: string) => ({ fields: [field] });
  assert.deepEqual(unknown, {
    status: 400,
    body: { code: "signal_kind_unknown", details: fields("kind") },
  });
  const profile = { postUrl: "https://www.linkedin.com/in/example-author/" };
  assert.deepEqual(await call(a, "POST", "", { ...newSource(sender), config: profile }), {
    status: 400,
    body: { code: "signal_config_invalid", details: fields("config.postUrl") },
  });
});

test("POST a topic and an own-posts source: 201, stored canonical, each run at its save and daily; a phrase of 6 words, no role or a role twice 400 signal_config_invalid naming its field; a phrase on a special-category theme 400 signal_topic_blocked naming config.phrase, nothing stored", async () => {
  const [a] = await createTwoWorkspaces();
  const senderAccountId = await senderOf(a);
  const create = (kind: string, config: unknown) =>
    call(a, "POST", "", { kind, config, label: "Signals", senderAccountId });
  const topic = (config: unknown) => create("topic_engagement", config);
  const created = await topic({ phrase: "  revenue   operations ", roles: ["reactor", "author"] });
  assert.equal(created.status, 201);
  const { config, createdAt, fireTimes, cadence } = created.body;
  const canonical = { phrase: "revenue operations", roles: ["author", "reactor"] };
  assert.deepEqual([config, fireTimes, cadence], [canonical, [createdAt], "daily"]);
  const own = await create("my_post_engagement", {});
  const { config: none, fireTimes: times, cadence: daily } = own.body;
  assert.deepEqual([own.status, none, times.length, daily], [201, {}, 1, "daily"]);
  const invalid = (field: string) => ({
    status: 400,
    body: { code: "signal_config_invalid", details: { fields: [field] } },
  });
  assert.deepEqual(
    await topic({ phrase: "one two three four five six" }),
    invalid("config.phrase"),
  );
  for (const roles of [[], ["author", "author"]]) {
    assert.deepEqual(await topic({ phrase: "revops", roles }), invalid("config.roles"));
  }
  assert.deepEqual(await topic({ phrase: "Mental Health at work" }), {
    status: 400,
    body: { code: "signal_topic_blocked", details: { fields: ["config.phrase"] } },
  });
  const where = { workspaceId: a.workspace.id };
  const stored = await asRole("app").signalSource.findMany({ where, orderBy: { id: "asc" } });
  assert.deepEqual(
    stored.map(({ kind, config }) => [kind, config]),
    [
      ["topic_engagement", canonical],
      ["my_post_engagement", {}],
    ],
  );
});

test("POST a competitor's page and a creator: 201, stored canonical, each run at its save and daily; a link of another kind of page or a name off 2 to 100 characters 400 signal_config_invalid naming each field, nothing stored; enabling a creator source the erasure emptied 400 naming config.profileUrl", async () => {
  const [a] = await createTwoWorkspaces();
  const senderAccountId = await senderOf(a);
  const create = (kind: string, config: unknown) =>
    call(a, "POST", "", { kind, config, label: "Signals", senderAccountId });
  const competitor = (config: unknown) => create("competitor_engagement", config);
  const creator = (profileUrl: string) => create("creator_engagement", { profileUrl });
  const page = "https://www.linkedin.com/company/acme-analytics";
  const profile = "https://www.linkedin.com/in/jane-doe";
  const rival = await competitor({
    companyUrl: "https://linkedin.com/company/acme-analytics/?trk=companies",
    companyName: "  Acme   Analytics ",
  });
  const jane = await creator(`${profile}/?originalSubdomain=uk`);
  const stored = { companyUrl: page, companyName: "Acme Analytics" };
  const created = [
    [rival, stored],
    [jane, { profileUrl: profile }],
  ] as const;
  for (const [{ status, body }, config] of created) {
    const answered = [status, body.config, body.fireTimes, body.cadence];
    assert.deepEqual(answered, [201, config, [body.createdAt], "daily"]);
  }
  const invalid = (...fields: string[]) => ({
    status: 400,
    body: { code: "signal_config_invalid", details: { fields } },
  });
  const url = invalid("config.companyUrl");
  assert.deepEqual(await competitor({ ...stored, companyUrl: profile }), url);
  assert.deepEqual(
    await competitor({ ...stored, companyName: "A" }),
    invalid("config.companyName"),
  );
  assert.deepEqual(
    await competitor({ companyUrl: POST_URL, companyName: "x".repeat(101) }),
    invalid("config.companyUrl", "config.companyName"),
  );
  assert.deepEqual(await creator(page), invalid("config.profileUrl"));
  const app = asRole("app");
  const rows = await app.signalSource.findMany({
    where: { workspaceId: a.workspace.id },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(
    rows.map(({ kind, config }) => [kind, config]),
    [
      ["competitor_engagement", stored],
      ["creator_engagement", { profileUrl: profile }],
    ],
  );
  // As the erasure leaves a creator source (signals' tests/erase.test.ts).
  const erased = { enabled: false, config: { profileUrl: "" }, label: "" };
  await app.signalSource.update({ where: { id: jane.body.id }, data: erased });
  assert.deepEqual(
    await call(a, "PATCH", `/${jane.body.id}`, { enabled: true }),
    invalid("config.profileUrl"),
  );
});

test("POST …/run on a post engagers source saved more than its lookback ago is 409 signal_source_expired; enabling a source whose post the erasure emptied is 400 signal_config_invalid naming config.postUrl", async () => {
  const [a] = await createTwoWorkspaces();
  const { id } = (await call(a, "POST", "", newSource(await senderOf(a)))).body;
  const app = asRole("app");
  const savedAt = new Date(Date.now() - 31 * 86_400_000);
  await app.signalSource.update({ where: { id }, data: { createdAt: savedAt } });
  const expired = { code: "signal_source_expired" };
  assert.deepEqual(await runNow(a, id, randomUUID()), {
    status: 409,
    replayed: null,
    body: expired,
  });
  // As the erasure leaves it (signals' tests/erase.test.ts): disabled, its URL and label emptied.
  const erased = { enabled: false, config: { postUrl: "" }, label: "" };
  await app.signalSource.update({ where: { id }, data: erased });
  assert.deepEqual(await call(a, "PATCH", `/${id}`, { enabled: true }), {
    status: 400,
    body: { code: "signal_config_invalid", details: { fields: ["config.postUrl"] } },
  });
});

test("POST a source with an lnkd.in short link: one GET to the link itself, unfollowed, and the post's URL stored without the query; a 200 or another page 400 signal_config_invalid, a failed request 502 signal_post_link_unreachable; a full link no request; no log line carries a link", async (t) => {
  const [a] = await createTwoWorkspaces();
  const sender = await senderOf(a);
  const shared = POST_URL.replace("-activity-", "-share-");
  const SHORT = "https://lnkd.in/p/gNJ7DVDG";
  const redirect = (status: number, location?: string): FetchSafeResponse => ({
    status,
    headers: location === undefined ? {} : { location },
    body: Buffer.alloc(0),
    truncated: false,
    finalUrl: SHORT,
    hops: 0,
  });
  let answer: FetchSafeResponse | Error = redirect(301, `${shared}?utm_source=share&rcm=ACoAAB`);
  const get = t.mock.method(shortLinks, "get", async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const create = (postUrl: string) =>
    call(a, "POST", "", { ...newSource(sender), config: { postUrl } });
  const links = [SHORT, "https://lnkd.in/gNJ7DVDG"];
  for (const link of links) {
    const created = await create(link);
    assert.deepEqual([created.status, created.body.config], [201, { postUrl: shared }]);
    const { id } = created.body;
    const row = await asRole("app").signalSource.findUniqueOrThrow({ where: { id } });
    assert.deepEqual(row.config, { postUrl: shared });
  }
  const requests = get.mock.calls.map(({ arguments: [url, options] }) => [
    url,
    options?.maxRedirects,
    options?.returnRedirect,
  ]);
  assert.deepEqual(requests, [
    [SHORT, 0, true],
    ["https://lnkd.in/gNJ7DVDG", 0, true],
  ]);
  assert.equal((await create(POST_URL)).status, 201);
  assert.equal(get.mock.callCount(), 2);

  const fields = ["config.postUrl"];
  const invalid = { status: 400, body: { code: "signal_config_invalid", details: { fields } } };
  for (const other of [redirect(200), redirect(301, "https://www.linkedin.com/feed/")]) {
    answer = other;
    assert.deepEqual(await create(SHORT), invalid);
  }
  answer = new AppError("egress_timeout");
  const unreachable = { status: 502, body: { code: "signal_post_link_unreachable" } };
  assert.deepEqual(await create(SHORT), unreachable);
  const failed = logs.lines().filter(({ msg }) => msg === "api: request failed");
  const causes = failed.map(({ err }) => (err as { cause?: unknown }).cause);
  assert.deepEqual(causes, [{ type: "AppError", code: "egress_timeout" }]);
  assert.ok(!logs.raw.some((line) => /lnkd\.in|gNJ7DVDG|7250000000000000000/.test(line)));
});

test("the eleventh enabled source in no agent is 400 signal_sources_limit, also when two arrive at once; disabling one lets the next in", async () => {
  const [a] = await createTwoWorkspaces();
  const sender = await senderOf(a);
  const ids: string[] = [];
  for (let n = 1; n <= 9; n++)
    ids.push((await call(a, "POST", "", newSource(sender, `Post ${n}`))).body.id);
  const both = await Promise.all([
    call(a, "POST", "", newSource(sender)),
    call(a, "POST", "", newSource(sender)),
  ]);
  const limited = { code: "signal_sources_limit", details: { limit: 10 } };
  assert.deepEqual(both.map(({ status }) => status).sort(), [201, 400]);
  assert.deepEqual(both.find(({ status }) => status === 400)?.body, limited);

  const disabled = await call(a, "PATCH", `/${ids[0]}`, { enabled: false });
  const { enabled, fireTimes, nextRunAt } = disabled.body;
  assert.deepEqual([disabled.status, enabled, fireTimes, nextRunAt], [200, false, [], null]);
  assert.equal((await call(a, "POST", "", newSource(sender))).status, 201);
  assert.deepEqual(await call(a, "PATCH", `/${ids[0]}`, { enabled: true }), {
    status: 400,
    body: limited,
  });
});

test("the eleventh enabled competitor or creator source of one sender account is 400 signal_tracked_limit at the create and at the enable, also when two arrive at once; disabling one lets the next in; another account's tracked source, or a post on the same account, meets the limit of the sources in no agent instead", async () => {
  const [a] = await createTwoWorkspaces();
  const first = await senderOf(a);
  const second = await senderOf(a);
  /** A competitor's page for an even `n`, a creator for an odd one, on the account. */
  const tracked = (senderAccountId: string, n: number) => {
    const competitor = {
      kind: "competitor_engagement",
      config: {
        companyUrl: `https://www.linkedin.com/company/rival-${n}`,
        companyName: `Rival ${n}`,
      },
    };
    const creator = {
      kind: "creator_engagement",
      config: { profileUrl: `https://www.linkedin.com/in/creator-${n}` },
    };
    const source = n % 2 === 0 ? competitor : creator;
    return call(a, "POST", "", { ...source, label: `Tracked ${n}`, senderAccountId });
  };
  const ids: string[] = [];
  for (let n = 1; n <= 9; n++) ids.push((await tracked(first, n)).body.id);
  const both = await Promise.all([tracked(first, 10), tracked(first, 11)]);
  const limited = { status: 400, body: { code: "signal_tracked_limit", details: { limit: 10 } } };
  assert.deepEqual(both.map(({ status }) => status).sort(), [201, 400]);
  assert.deepEqual(
    both.find(({ status }) => status === 400),
    limited,
  );
  assert.deepEqual(await tracked(first, 12), limited);

  assert.equal((await call(a, "PATCH", `/${ids[0]}`, { enabled: false })).status, 200);
  assert.equal((await tracked(first, 13)).status, 201);
  assert.deepEqual(await call(a, "PATCH", `/${ids[0]}`, { enabled: true }), limited);
  const full = { status: 400, body: { code: "signal_sources_limit", details: { limit: 10 } } };
  assert.deepEqual(await tracked(second, 14), full);
  assert.deepEqual(await call(a, "POST", "", newSource(first)), full);
});

test("the enabled limit counts by group (gamma-p5-045): three agents with 10 enabled sources each and 10 enabled in no agent are all allowed; an 11th enabled in no agent, or in an agent, is 400 signal_sources_limit, and of two enables of one agent at once one passes", async () => {
  const [a] = await createTwoWorkspaces();
  const sender = await senderOf(a, a.user.id);
  // The factory links past playbooks' 10 per agent, as a lower SIGNALS_MAX_ENABLED_SOURCES makes
  // reachable: signals' own count is what refuses them.
  const [eleventhOfA = ""] = await seeded(a, sender, 1, false);
  await agentOf(a, "Agent A", [...(await seeded(a, sender, 10)), eleventhOfA]);
  const offInB = await seeded(a, sender, 2, false);
  await agentOf(a, "Agent B", [...(await seeded(a, sender, 9)), ...offInB]);
  await agentOf(a, "Agent C", await seeded(a, sender, 10));
  await seeded(a, sender, 9);
  const tenth = await call(a, "POST", "", newSource(sender, "Tenth in no agent"));
  assert.equal(tenth.status, 201);
  assert.equal(tenth.body.playbook, null);
  const both = await Promise.all(offInB.map((id) => call(a, "PATCH", `/${id}`, { enabled: true })));
  assert.deepEqual(both.map(({ status }) => status).sort(), [200, 400]);
  const where = { workspaceId: a.workspace.id, enabled: true };
  assert.equal(await asRole("app").signalSource.count({ where }), 40);

  const limited = { status: 400, body: { code: "signal_sources_limit", details: { limit: 10 } } };
  assert.deepEqual(
    both.find(({ status }) => status === 400),
    limited,
  );
  assert.deepEqual(await call(a, "POST", "", newSource(sender, "Eleventh in no agent")), limited);
  assert.deepEqual(await call(a, "PATCH", `/${eleventhOfA}`, { enabled: true }), limited);
  // A group's room is its own: one of A's disabled, its 11th goes in, and no other group's.
  const ofA = (await call(a, "GET")).body.sources.filter(
    (source: { playbook: { name: string } | null; enabled: boolean }) =>
      source.playbook?.name === "Agent A" && source.enabled,
  );
  assert.equal((await call(a, "PATCH", `/${ofA[0].id}`, { enabled: false })).status, 200);
  assert.equal((await call(a, "PATCH", `/${eleventhOfA}`, { enabled: true })).status, 200);
  assert.deepEqual(await call(a, "POST", "", newSource(sender, "Still eleventh")), limited);
});

test("GET …/sources names each source's agent, or null, as PATCH does; DELETE removes the source's link to its agent in its run: playbookOfSource answers null and the agent holds the rest", async () => {
  const [a] = await createTwoWorkspaces();
  const sender = await senderOf(a, a.user.id);
  const linked = (await call(a, "POST", "", newSource(sender, "Linked"))).body;
  const kept = (await call(a, "POST", "", newSource(sender, "Kept"))).body;
  const free = (await call(a, "POST", "", newSource(sender, "Free"))).body;
  const playbookId = await agentOf(a, "Revenue agent", [linked.id, kept.id]);
  const agent = { id: playbookId, name: "Revenue agent" };
  const listed = (await call(a, "GET")).body.sources;
  assert.deepEqual(
    listed.map(({ label, playbook }: { label: string; playbook: unknown }) => [label, playbook]),
    [
      ["Free", null],
      ["Kept", agent],
      ["Linked", agent],
    ],
  );
  const relabeled = await call(a, "PATCH", `/${linked.id}`, { label: "Linked, renamed" });
  assert.deepEqual([relabeled.status, relabeled.body.playbook], [200, agent]);
  assert.equal((await call(a, "PATCH", `/${free.id}`, { enabled: false })).body.playbook, null);

  assert.deepEqual(await call(a, "DELETE", `/${linked.id}`), { status: 204, body: undefined });
  const principal = servicePrincipal("signals_test");
  const inRun = <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId: a.workspace.id, principal }, fn, { client: asRole("app") });
  assert.equal(await inRun(() => playbooks.playbookOfSource(linked.id)), null);
  assert.equal(await asRole("app").playbookSource.count({ where: { sourceId: linked.id } }), 0);
  assert.deepEqual(await inRun(() => playbooks.sourcesOf(playbookId)), [kept.id]);
});

test("with signals loaded, PUT …/playbooks/{playbookId}/sources asks signals' checker: a source read through the agent owner's account is linked and named on the source; one read through another member's is 409 playbook_source_wrong_owner; an unknown id, and another workspace's source, 409 playbook_source_not_found; nothing written on a refusal", async () => {
  const [a, b] = await createTwoWorkspaces();
  const own = (await call(a, "POST", "", newSource(await senderOf(a, a.user.id), "Own"))).body;
  const others = await senderOf(a, "usr_another_member");
  const theirs = (await call(a, "POST", "", newSource(others, "Another member's"))).body;
  const elsewhere = (await call(b, "POST", "", newSource(await senderOf(b, b.user.id)))).body;
  const playbookId = await agentOf(a, "Revenue agent");
  const put = (sourceIds: string[]) => agents(a, "PUT", `/${playbookId}/sources`, { sourceIds });
  const refused = (code: string, sourceIds: string[]) => ({
    status: 409,
    body: { code, details: { sourceIds } },
  });
  assert.deepEqual(
    await put([own.id, theirs.id]),
    refused("playbook_source_wrong_owner", [theirs.id]),
  );
  const unknown = newId("src");
  assert.deepEqual(await put([unknown]), refused("playbook_source_not_found", [unknown]));
  assert.deepEqual(await put([elsewhere.id]), refused("playbook_source_not_found", [elsewhere.id]));
  assert.equal(await asRole("app").playbookSource.count({ where: { playbookId } }), 0);

  const linked = await put([own.id]);
  assert.deepEqual([linked.status, linked.body.sourceIds], [200, [own.id]]);
  const named = (await call(a, "GET")).body.sources.map(
    ({ label, playbook }: { label: string; playbook: { id: string } | null }) => [
      label,
      playbook?.id ?? null,
    ],
  );
  assert.deepEqual(named, [
    ["Another member's", null],
    ["Own", playbookId],
  ]);
});

test("GET …/sources/{id}/runs: factory-seeded runs newest first, those not started yet on top; another workspace's source is 404", async () => {
  const [a, b] = await createTwoWorkspaces();
  const source = (await call(a, "POST", "", newSource(await senderOf(a)))).body;
  const at = (hour: number) => new Date(Date.UTC(2026, 9, 22, hour));
  const seed = (run: Omit<Parameters<typeof createSignalRun>[0], "workspaceId" | "sourceId">) =>
    createSignalRun({ workspaceId: a.workspace.id, sourceId: source.id, ...run });
  const done = await seed({
    status: "done",
    startedAt: at(1),
    finishedAt: at(2),
    counts: { read: 95 },
  });
  const failed = await seed({
    status: "failed",
    startedAt: at(5),
    finishedAt: at(6),
    error: "linkedin_account_disconnected",
  });
  const scheduled = await seed({ status: "scheduled" });
  const waiting = await seed({ status: "waiting", startedAt: at(3) });

  const { status, body } = await call(a, "GET", `/${source.id}/runs`);
  assert.equal(status, 200);
  const order = [scheduled, failed, waiting, done].map((run) => run.id);
  assert.deepEqual(
    body.runs.map((run: { id: string }) => run.id),
    order,
  );
  assert.deepEqual(body.runs[1], {
    id: failed.id,
    sourceId: source.id,
    status: "failed",
    startedAt: at(5).toISOString(),
    finishedAt: at(6).toISOString(),
    counts: {},
    error: "linkedin_account_disconnected",
    stopRequestedAt: null,
  });
  assert.deepEqual(body.runs[3].counts, { read: 95 });
  assert.deepEqual(await call(b, "GET", `/${source.id}/runs`), {
    status: 404,
    body: { code: "signal_source_not_found" },
  });
});

test("GET …/sources/{id}/research-plan: {plan: null} before any, then the newest plan's words by language, its source types' ids and when it was made, from a run of the source; another workspace's source is 404 signal_source_not_found; (gamma-wr-041)", async () => {
  const [a, b] = await createTwoWorkspaces();
  const made = await call(a, "POST", "", {
    kind: "web_research",
    config: { focus: "makers of cold-chain loggers" },
    label: "Loggers",
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const sourceId = made.body.id as string;
  assert.deepEqual(await call(a, "GET", `/${sourceId}/research-plan`), {
    status: 200,
    body: { plan: null },
  });
  const run = async (hour: number) =>
    createSignalRun({
      ...{ workspaceId: a.workspace.id, sourceId, status: "done" as const },
      startedAt: new Date(Date.UTC(2026, 10, 19, hour)),
    });
  const plan = (runId: string, word: string) =>
    createResearchPlan({
      ...{ workspaceId: a.workspace.id, sourceId, runId },
      words: [{ language: "pl", words: [word] }],
      placeIds: ["web_search"],
    });
  await plan((await run(8)).id, "older word");
  const newest = (await run(9)).id;
  await plan(newest, "newer word");
  const { status, body } = await call(a, "GET", `/${sourceId}/research-plan`);
  assert.equal(status, 200);
  assert.deepEqual(
    [body.plan.runId, body.plan.words, body.plan.placeIds, typeof body.plan.madeAt],
    [newest, [{ language: "pl", words: ["newer word"] }], ["web_search"], "string"],
  );
  assert.deepEqual(Object.keys(body.plan).sort(), ["id", "madeAt", "placeIds", "runId", "words"]);
  assert.deepEqual(await call(b, "GET", `/${sourceId}/research-plan`), {
    status: 404,
    body: { code: "signal_source_not_found" },
  });
});

test("GET the sources and PATCH one: lastRunBudgetReached true while the run its lastRunAt names ended done at its read budget, false once a newer run did not; a failed run never (gamma-p5-040)", async () => {
  const [a] = await createTwoWorkspaces();
  const senderAccountId = await senderOf(a);
  const post = (await call(a, "POST", "", newSource(senderAccountId))).body;
  const config = { phrase: "revops", roles: ["commenter"] };
  const daily = { kind: "topic_engagement", config, label: "Topic", senderAccountId };
  const topic = (await call(a, "POST", "", daily)).body;
  const at = (hour: number) => new Date(Date.UTC(2026, 9, 22, hour));
  const app = asRole("app");
  type Counts = Record<string, number>;
  /** A run of the source started at the hour, and the source's lastRunAt, as a run's start sets it. */
  const ran = async (sourceId: string, status: "done" | "failed", hour: number, counts: Counts) => {
    const times = { startedAt: at(hour), finishedAt: at(hour + 1) };
    await createSignalRun({ workspaceId: a.workspace.id, sourceId, status, ...times, counts });
    await app.signalSource.update({ where: { id: sourceId }, data: { lastRunAt: at(hour) } });
  };
  const reached = { read: 30, budget_reached: 1 };
  await ran(topic.id, "done", 1, reached);
  await ran(post.id, "failed", 1, reached);
  type Listed = { label: string; cadence: string | null; lastRunBudgetReached: boolean };
  const listed = async () =>
    (await call(a, "GET")).body.sources.map((source: Listed) => [
      source.label,
      source.cadence,
      source.lastRunBudgetReached,
    ]);
  assert.deepEqual(await listed(), [
    ["Topic", "daily", true],
    ["Launch post", null, false],
  ]);
  const renamed = await call(a, "PATCH", `/${topic.id}`, { label: "Renamed" });
  assert.deepEqual([renamed.status, renamed.body.lastRunBudgetReached], [200, true]);

  await ran(topic.id, "done", 3, { read: 3 });
  assert.deepEqual(await listed(), [
    ["Renamed", "daily", false],
    ["Launch post", null, false],
  ]);
});

test("signals.source_created, signals.source_updated when enabled changes and signals.source_deleted are published with ids only, the deleted one with its open runs' workflow ids, Run now's when none was recorded; DELETE takes the runs too", async () => {
  const [a] = await createTwoWorkspaces();
  const source = (await call(a, "POST", "", newSource(await senderOf(a)))).body;
  const relabeled = await call(a, "PATCH", `/${source.id}`, { label: "Renamed" });
  assert.deepEqual([relabeled.status, relabeled.body.label], [200, "Renamed"]);
  assert.equal((await call(a, "PATCH", `/${source.id}`, { enabled: false })).status, 200);
  await createSignalRun({ workspaceId: a.workspace.id, sourceId: source.id });
  const run = { workspaceId: a.workspace.id, sourceId: source.id, status: "waiting" as const };
  const waiting = await createSignalRun(run);

  assert.deepEqual(await call(a, "DELETE", `/${source.id}`), { status: 204, body: undefined });
  assert.deepEqual(await call(a, "GET"), { status: 200, body: { sources: [] } });
  assert.equal(await asRole("app").signalRun.count({ where: { sourceId: source.id } }), 0);
  assert.deepEqual(await call(a, "DELETE", `/${source.id}`), {
    status: 404,
    body: { code: "signal_source_not_found" },
  });
  const outbox = await asRole("app").outboxEntry.findMany({
    where: { workspaceId: a.workspace.id },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(
    outbox.map(({ eventName, payload }) => [eventName, payload]),
    [
      ["signals.source_created", { source_id: source.id }],
      ["signals.source_updated", { source_id: source.id }],
      [
        "signals.source_deleted",
        { source_id: source.id, workflow_ids: [`signals.run:${a.workspace.id}:${waiting.id}`] },
      ],
    ],
  );
});

test("a sender account not of the workspace is 400 signal_sender_account_invalid naming senderAccountId; a disconnected one of the workspace is taken", async () => {
  const [a, b] = await createTwoWorkspaces();
  const invalid = {
    status: 400,
    body: { code: "signal_sender_account_invalid", details: { fields: ["senderAccountId"] } },
  };
  assert.deepEqual(await call(a, "POST", "", newSource(await senderOf(b))), invalid);
  assert.deepEqual(await call(a, "POST", "", newSource("sac_01JAB3K5ZQ7W9R2M4T6V8X0Y1C")), invalid);
  const ours = await senderOf(a);
  const disconnected = { status: "disconnected" as const };
  await asRole("app").senderAccount.update({ where: { id: ours }, data: disconnected });
  assert.equal((await call(a, "POST", "", newSource(ours))).status, 201);
});

test("POST …/sources/{id}/run: 202 with the run, scheduled, and one signals.run_requested; its key again answers the same, replayed, with no second; no key is 400; another workspace's source is 404", async () => {
  const [a, b] = await createTwoWorkspaces();
  const source = (await call(a, "POST", "", newSource(await senderOf(a)))).body;
  const key = randomUUID();
  const first = await runNow(a, source.id, key);
  const { id } = first.body;
  const run = { id, sourceId: source.id, status: "scheduled", counts: {}, error: null };
  const times = { startedAt: null, finishedAt: null, stopRequestedAt: null };
  assert.deepEqual(first, {
    status: 202,
    replayed: null,
    body: { ...run, ...times },
  });
  assert.deepEqual(await runNow(a, source.id, key), { ...first, replayed: "true" });
  const rows = await asRole("app").signalRun.findMany({ where: { sourceId: source.id } });
  assert.deepEqual(
    rows.map((row) => [row.id, row.workspaceId, row.status]),
    [[id, a.workspace.id, "scheduled"]],
  );
  const requested = await asRole("app").outboxEntry.findMany({
    where: { workspaceId: a.workspace.id, eventName: "signals.run_requested" },
  });
  assert.deepEqual(
    requested.map(({ payload }) => payload),
    [{ source_id: source.id, run_id: id }],
  );
  const required = await runNow(a, source.id);
  assert.deepEqual([required.status, required.body.code], [400, "idempotency_key_required"]);
  assert.deepEqual(await runNow(b, source.id, randomUUID()), {
    status: 404,
    replayed: null,
    body: { code: "signal_source_not_found" },
  });
});

test("POST …/sources/{id}/run while one of the source's runs is running or waiting: 409 signal_run_open, and runOpen true and openRun that run's id and status in the list and on a change, a running one before a newer waiting one; a scheduled or ended run leaves it 202, runOpen false and openRun null", async () => {
  const [a] = await createTwoWorkspaces();
  const source = (await call(a, "POST", "", newSource(await senderOf(a)))).body;
  const seed = (status: "scheduled" | "running" | "waiting") =>
    createSignalRun({ workspaceId: a.workspace.id, sourceId: source.id, status });
  const open = ({ runOpen, openRun }: { runOpen: boolean; openRun: unknown }) => ({
    runOpen,
    openRun,
  });
  const listed = async () => open((await call(a, "GET")).body.sources[0]);
  const end = (...ids: string[]) =>
    asRole("app").signalRun.updateMany({ where: { id: { in: ids } }, data: { status: "done" } });
  const refused = { status: 409, replayed: null, body: { code: "signal_run_open" } };
  for (const status of ["running", "waiting"] as const) {
    const run = await seed(status);
    const expected = { runOpen: true, openRun: { id: run.id, status, stopRequestedAt: null } };
    assert.deepEqual(await listed(), expected);
    assert.deepEqual(
      open((await call(a, "PATCH", `/${source.id}`, { label: status })).body),
      expected,
    );
    assert.deepEqual(await runNow(a, source.id, randomUUID()), refused);
    await end(run.id);
  }
  const running = await seed("running");
  const waiting = await seed("waiting");
  const openRun = { id: running.id, status: "running", stopRequestedAt: null };
  const shown = { runOpen: true, openRun };
  assert.deepEqual(await listed(), shown);
  await end(running.id, waiting.id);
  await seed("scheduled");
  assert.deepEqual(await listed(), { runOpen: false, openRun: null });
  assert.equal((await runNow(a, source.id, randomUUID())).status, 202);
});

test("POST …/sources/{id}/run on a source whose agent is paused, by a member or for its owner's removal: 409 signal_agent_paused, no run written and nothing published; the agent resumed, 202 (paused-agent-sources)", async () => {
  const [a] = await createTwoWorkspaces();
  const sender = await senderOf(a, a.user.id);
  const refused = { status: 409, replayed: null, body: { code: "signal_agent_paused" } };
  const requestsOf = async (sourceId: string) =>
    (
      await asRole("app").outboxEntry.findMany({
        where: { workspaceId: a.workspace.id, eventName: "signals.run_requested" },
      })
    ).filter(({ payload }) => (payload as { source_id: string }).source_id === sourceId).length;
  for (const pausedReason of ["user", "member_removed"] as const) {
    const source = (await call(a, "POST", "", newSource(sender, `Paused, ${pausedReason}`))).body;
    const playbookId = await createPlaybook({
      ...{ workspaceId: a.workspace.id, icpId: `icp_paused_${pausedReason}` },
      ...{ ownerUserId: a.user.id, name: `Paused for ${pausedReason}`, status: "paused" },
      ...{ pausedReason, sourceIds: [source.id] },
    });
    assert.deepEqual(await runNow(a, source.id, randomUUID()), refused);
    const runs = () => asRole("app").signalRun.count({ where: { sourceId: source.id } });
    assert.deepEqual([await runs(), await requestsOf(source.id)], [0, 0]);

    const resumed = { status: "active" as const, pausedReason: null };
    await asRole("app").playbook.update({ where: { id: playbookId }, data: resumed });
    assert.equal((await runNow(a, source.id, randomUUID())).status, 202);
    assert.deepEqual([await runs(), await requestsOf(source.id)], [1, 1]);
  }
});

test("POST …/sources/{id}/runs/{runId}/stop: 202 with the run and its stopRequestedAt, one signals.run_stop_requested, and the list's open run with it; a second stop 202, the first time kept, published again; its key again replayed; a run that ended 409 signal_run_not_open; another source's run or another workspace's 404 signal_source_not_found; a user without signals.run, no member, 403", async () => {
  const [a, b] = await createTwoWorkspaces();
  const sender = await senderOf(a);
  const source = (await call(a, "POST", "", newSource(sender))).body;
  const other = (await call(a, "POST", "", newSource(sender, "Other post"))).body;
  const seed = (status: "waiting" | "done" | "failed" | "cancelled") =>
    createSignalRun({ workspaceId: a.workspace.id, sourceId: source.id, status });
  const waiting = await seed("waiting");
  const key = randomUUID();
  const first = await stop(a, source.id, waiting.id, key);
  const { stopRequestedAt } = first.body;
  assert.equal(first.status, 202);
  assert.deepEqual(first.body, {
    ...{ id: waiting.id, sourceId: source.id, status: "waiting", counts: {}, error: null },
    ...{ startedAt: null, finishedAt: null, stopRequestedAt },
  });
  assert.ok(stopRequestedAt && !Number.isNaN(Date.parse(stopRequestedAt)));
  const listed = (await call(a, "GET")).body.sources.find(
    (s: { id: string }) => s.id === source.id,
  );
  assert.deepEqual(listed.openRun, { id: waiting.id, status: "waiting", stopRequestedAt });
  assert.deepEqual(await stop(a, source.id, waiting.id), first);
  assert.deepEqual(await stop(a, source.id, waiting.id, key), { ...first, replayed: "true" });
  const published = await asRole("app").outboxEntry.findMany({
    where: { workspaceId: a.workspace.id, eventName: "signals.run_stop_requested" },
  });
  const requested = { source_id: source.id, run_id: waiting.id };
  assert.deepEqual(
    published.map(({ payload }) => payload),
    [requested, requested],
  );

  const ended = { status: 409, replayed: null, body: { code: "signal_run_not_open" } };
  for (const status of ["done", "failed", "cancelled"] as const) {
    assert.deepEqual(await stop(a, source.id, (await seed(status)).id), ended);
  }
  const notFound = { status: 404, replayed: null, body: { code: "signal_source_not_found" } };
  assert.deepEqual(await stop(a, other.id, waiting.id), notFound);
  assert.deepEqual(await stop(b, source.id, waiting.id), notFound);
  const forbidden = { status: 403, replayed: null, body: { code: "forbidden" } };
  const nobody = await createUser();
  assert.deepEqual(await stop(a, source.id, waiting.id, randomUUID(), nobody.id), forbidden);
});

const GRAIN = { focus: "traders of grain", languages: ["en"] };
const researchSource = (config: unknown = GRAIN, label = "Grain") => ({
  kind: "web_research",
  config,
  label,
});

test("POST a web_research source with no LinkedIn account in the workspace: 201 with senderAccountId null, no fire time, cadence research every 7 days; one given is 400 signal_sender_account_invalid naming senderAccountId, and so is a LinkedIn kind's missing one; each bad field is signal_config_invalid naming it, nothing stored (gamma-wr-030)", async () => {
  const [a] = await createTwoWorkspaces();
  assert.equal(
    await asRole("app").senderAccount.count({ where: { workspaceId: a.workspace.id } }),
    0,
  );
  const created = await call(a, "POST", "", researchSource());
  assert.equal(created.status, 201);
  const row = await asRole("app").signalSource.findUniqueOrThrow({
    where: { id: created.body.id },
  });
  assert.equal(row.senderAccountId, null);
  assert.deepEqual(created.body, {
    id: row.id,
    kind: "web_research",
    config: GRAIN,
    label: "Grain",
    senderAccountId: null,
    enabled: true,
    createdBy: a.user.id,
    createdAt: row.createdAt.toISOString(),
    lastRunAt: null,
    fireTimes: [],
    nextRunAt: null,
    runOpen: false,
    openRun: null,
    cadence: "research",
    everyDays: 7,
    lastRunBudgetReached: false,
    sourceImport: null,
    playbook: null,
  });
  assert.deepEqual(await call(a, "GET"), { status: 200, body: { sources: [created.body] } });
  const invalid = (field: string, code = "signal_config_invalid") => ({
    status: 400,
    body: { code, details: { fields: [field] } },
  });
  const sender = await senderOf(a);
  const given = await call(a, "POST", "", { ...researchSource(), senderAccountId: sender });
  assert.deepEqual(given, invalid("senderAccountId", "signal_sender_account_invalid"));
  const { senderAccountId: _given, ...bare } = newSource(sender);
  const linkedin = await call(a, "POST", "", bare);
  assert.deepEqual(linkedin, invalid("senderAccountId", "signal_sender_account_invalid"));
  const pages = Array.from({ length: 6 }, (_, at) => `https://site${at}.example/`);
  const bad: [string, unknown][] = [
    ["config.focus", { focus: "ab" }],
    ["config.region", { ...GRAIN, region: "r".repeat(101) }],
    ["config.languages", { ...GRAIN, languages: ["en", "fr", "de", "es"] }],
    ["config.languages", { ...GRAIN, languages: ["zz"] }],
    ["config.startPages", { ...GRAIN, startPages: pages }],
    ["config.startPages", { ...GRAIN, startPages: ["https://www.linkedin.com/company/acme"] }],
    ["config.startPages", { ...GRAIN, startPages: ["http://registry.example/"] }],
  ];
  for (const [field, config] of bad) {
    assert.deepEqual(await call(a, "POST", "", researchSource(config)), invalid(field), field);
  }
  assert.equal((await call(a, "GET")).body.sources.length, 1, "a refusal stored a source");
});

test("PATCH {config} on a research source stores what its schema reads and answers it, the label and the switch as before; on a LinkedIn kind's source it is 400 signal_config_invalid naming config, and a Member's PATCH of another member's research source is 403", async () => {
  const [a] = await createTwoWorkspaces();
  const made = (await call(a, "POST", "", researchSource())).body;
  const next = { focus: "  brokers of   shipping ", startPages: ["https://Registry.example/a#x"] };
  const patched = await call(a, "PATCH", `/${made.id}`, { config: next });
  assert.equal(patched.status, 200);
  const stored = { focus: "brokers of shipping", startPages: ["https://registry.example/a"] };
  assert.deepEqual([patched.body.config, patched.body.label], [stored, "Grain"]);
  const row = await asRole("app").signalSource.findUniqueOrThrow({ where: { id: made.id } });
  assert.deepEqual(row.config, stored);
  const bad = await call(a, "PATCH", `/${made.id}`, { config: { focus: "x" } });
  assert.deepEqual(bad, {
    status: 400,
    body: { code: "signal_config_invalid", details: { fields: ["config.focus"] } },
  });
  const renamed = await call(a, "PATCH", `/${made.id}`, { label: "Shipping", enabled: false });
  assert.deepEqual(
    [renamed.body.label, renamed.body.enabled, renamed.body.config],
    ["Shipping", false, stored],
  );
  const post = (await call(a, "POST", "", newSource(await senderOf(a)))).body;
  const config = { postUrl: POST_URL };
  const refused = await call(a, "PATCH", `/${post.id}`, { config });
  assert.deepEqual(refused, {
    status: 400,
    body: { code: "signal_config_invalid", details: { fields: ["config"] } },
  });
  const unchanged = await asRole("app").signalSource.findUniqueOrThrow({ where: { id: post.id } });
  assert.deepEqual(unchanged.config, config);
});

test("a research source is linked to its creator's agent through playbooks' route and shown on the source, named; one another member made is 409 playbook_source_wrong_owner for my agent; Run now writes its run, 202 scheduled, and 409 signal_agent_paused once the agent is paused (gamma-wr-030)", async () => {
  const [a] = await createTwoWorkspaces();
  const mine = (await call(a, "POST", "", researchSource(GRAIN, "Mine"))).body;
  const workspaceId = a.workspace.id;
  const made = { workspaceId, label: "Theirs", kind: "web_research", config: GRAIN };
  const theirs = await createSignalSource({
    ...made,
    ...{ senderAccountId: null, createdBy: "usr_another_member" },
  });
  const playbookId = await agentOf(a, "Research agent");
  const put = (sourceIds: string[]) => agents(a, "PUT", `/${playbookId}/sources`, { sourceIds });
  assert.deepEqual(await put([mine.id, theirs.id]), {
    status: 409,
    body: { code: "playbook_source_wrong_owner", details: { sourceIds: [theirs.id] } },
  });
  assert.equal(await asRole("app").playbookSource.count({ where: { playbookId } }), 0);
  const linked = await put([mine.id]);
  assert.deepEqual([linked.status, linked.body.sourceIds], [200, [mine.id]]);
  const listed = (await call(a, "GET")).body.sources as { id: string; playbook: unknown }[];
  const named = listed.find(({ id }) => id === mine.id);
  assert.deepEqual(named?.playbook, { id: playbookId, name: "Research agent" });
  const run = await runNow(a, mine.id, randomUUID());
  assert.deepEqual([run.status, run.body.status, run.body.sourceId], [202, "scheduled", mine.id]);
  const outbox = { workspaceId, eventName: "signals.run_requested" };
  assert.equal(await asRole("app").outboxEntry.count({ where: outbox }), 1);
  // Paused: no run is written.
  await asRole("app").playbook.update({
    where: { id: playbookId },
    data: { status: "paused", pausedReason: "user" },
  });
  const paused = await runNow(a, mine.id, randomUUID());
  assert.deepEqual([paused.status, paused.body.code], [409, "signal_agent_paused"]);
  assert.equal(await asRole("app").signalRun.count({ where: { sourceId: mine.id } }), 1);
});
