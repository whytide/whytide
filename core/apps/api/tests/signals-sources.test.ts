// signals' sources routes end to end (alpha-p8-010, alpha-p8-020, fix-run-stop;
// core/modules/signals/README.md "API"): the host started with identity's guard and the signals
// module, on the fake authentication adapter, in a schema of the worktree's database, answering real
// HTTP. It lives here: a module never imports a host. A source's sender account is a connected
// account of its workspace, written by linkedin's test factory. A short link's request is signals'
// shortLinks.get, mocked: no test leaves the laptop.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { AppError, collectLogs, createLogger, type FetchSafeResponse } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createTwoWorkspaces,
  createUser,
  type TestTenant,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

// signals, and linkedin's test hooks, by their builds' paths, as src/modules.generated.ts loads them:
// the api does not list a module with a screen (core/apps/web/docs/screens.md).
const build = new URL("../../../../modules/signals/dist/", import.meta.url);
type SignalsTesting = typeof import("../../../modules/signals/dist/testing/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
const testing: SignalsTesting = await import(new URL("testing/index.js", build).href);
const linkedin: LinkedinTesting = await import(
  new URL("../../linkedin/dist/testing/index.js", build).href
);
const { createSignalRun, shortLinks, useSignalsClient } = testing;

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

/** A connected sender account of the tenant's workspace. */
const senderOf = async (tenant: TestTenant) =>
  (await linkedin.createConnectedAccount(tenant.workspace.id)).id;

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

test("the eleventh enabled source is 400 signal_sources_limit, also when two arrive at once; disabling one lets the next in", async () => {
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
