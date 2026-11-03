// icp's routes end to end (alpha-p4-040; core/modules/icp/README.md "Routes"): the host started with
// identity, whose resolver lets a member into their workspace, and icp, on the fake authentication
// adapter, in a schema of the worktree's database, answering real HTTP; a write sends the app's
// Origin. The events are read from the outbox. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import type { ModuleLoader } from "../src/modules.ts";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

// icp by its build's path, as src/modules.generated.ts loads it: its screen depends on the web,
// which depends on the api, so the api's dev dependency on icp would close a cycle that pnpm
// refuses to order.
const icp = new URL("../../../../modules/icp/dist/index.js", import.meta.url).href;
const db = withTestDb();
useTenancyClient(asRole("app"));
const modules: ModuleLoader[] = [
  { name: "identity", load: () => import("@whytide/identity") },
  { name: "icp", load: () => import(icp) },
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

type Member = { readonly workspaceId: string; readonly cookie: string };
type Answer = { readonly status: number; readonly body: Record<string, unknown> };

const empty = {
  name: "",
  titles: [],
  seniorities: [],
  industries: [],
  sizeRanges: [],
  countries: [],
  mustHaves: "",
  disqualifiers: "",
};
const defaults = [
  { key: "title_function", weight: 30, isMust: true, enabled: true },
  { key: "seniority", weight: 15, isMust: false, enabled: true },
  { key: "company_size", weight: 10, isMust: false, enabled: true },
  { key: "industry", weight: 15, isMust: false, enabled: true },
  { key: "location", weight: 10, isMust: true, enabled: true },
  { key: "must_haves", weight: 20, isMust: false, enabled: true },
];

/** The Owner of a new workspace, signed in. */
async function member(): Promise<Member> {
  const [{ user, workspace }] = await createTwoWorkspaces();
  const cookie = signInAs(user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  return { workspaceId: workspace.id, cookie };
}

/** GET …/icp or …/icp/criteria, or a PUT of `body` there with the app's Origin. */
async function call(who: Member, path: "" | "/criteria", body?: object): Promise<Answer> {
  const url = new URL(`/v1/workspaces/${who.workspaceId}/icp${path}`, api.url);
  const write = { origin: APP_ORIGIN, "content-type": "application/json" };
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "PUT",
    headers: { cookie: who.cookie, ...(body === undefined ? {} : write) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The ICP's answer without its id and time, which change with every run. */
const fieldsOf = ({ body: { id: _id, updatedAt: _at, ...rest } }: Answer) => rest;

/** The payloads of icp.updated the workspace published, oldest first. */
async function published(workspaceId: string): Promise<unknown[]> {
  const where = { workspaceId, eventName: "icp.updated" };
  const rows = await asRole("app").outboxEntry.findMany({ where, orderBy: { id: "asc" } });
  return rows.map((row) => row.payload);
}

test("the first GET gives an empty ICP and six default criteria; a targeting PUT moves the version, the name alone keeps it", async () => {
  const who = await member();
  const [first, second] = await Promise.all([call(who, ""), call(who, "")]);
  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.equal(first.body.id, second.body.id, "two first reads at once make one ICP");
  assert.deepEqual(fieldsOf(first), { ...empty, version: 1 });
  assert.deepEqual(await call(who, "/criteria"), { status: 200, body: { criteria: defaults } });

  const targeting = { ...empty, titles: ["Head of Sales"], countries: ["FR", "DE"] };
  const saved = await call(who, "", targeting);
  assert.equal(saved.status, 200);
  assert.deepEqual(fieldsOf(saved), { ...targeting, countries: ["DE", "FR"], version: 2 });
  const renamed = await call(who, "", { ...targeting, name: "EMEA mid-market" });
  assert.deepEqual(
    [renamed.status, renamed.body.name, renamed.body.version],
    [200, "EMEA mid-market", 2],
  );
  assert.deepEqual(await call(who, ""), renamed, "a reload shows what was saved");
});

test("an unknown seniority, an invalid country, a must-haves text of 1,001 characters or weights summing to 90 answer 400 with the code", async () => {
  const who = await member();
  const refused = (code: string, details: object) => ({ status: 400, body: { code, details } });
  assert.deepEqual(
    await call(who, "", { ...empty, seniorities: ["vp", "chief"] }),
    refused("icp_unknown_seniority", { fields: ["seniorities.1"] }),
  );
  assert.deepEqual(
    await call(who, "", { ...empty, countries: ["FR", "XX"] }),
    refused("icp_unknown_country", { fields: ["countries.1"] }),
  );
  assert.deepEqual(
    await call(who, "", { ...empty, mustHaves: "x".repeat(1001) }),
    refused("validation_failed", { fields: ["mustHaves"] }),
  );
  const ninety = defaults.map((row) => (row.key === "industry" ? { ...row, weight: 5 } : row));
  assert.deepEqual(
    await call(who, "/criteria", { criteria: ninety }),
    refused("icp_weights_must_sum_100", { sum: 90 }),
  );
  assert.equal((await call(who, "")).body.version, 1, "nothing was saved");
  assert.deepEqual((await call(who, "/criteria")).body, { criteria: defaults });
});

test("icp.updated is published with the new version on a targeting change only", async () => {
  const who = await member();
  const event = (version: number) => ({ workspaceId: who.workspaceId, version });
  await call(who, "");
  await call(who, "", { ...empty, name: "Renamed" });
  const reweighted = defaults.map((row) =>
    row.key === "industry"
      ? { ...row, weight: 25 }
      : row.key === "location"
        ? { ...row, weight: 0 }
        : row,
  );
  assert.deepEqual(await call(who, "/criteria", { criteria: reweighted }), {
    status: 200,
    body: { criteria: reweighted },
  });
  assert.deepEqual(await published(who.workspaceId), []);
  await call(who, "", { ...empty, name: "Renamed", disqualifiers: "Agencies" });
  await call(who, "", {
    ...empty,
    name: "Renamed",
    disqualifiers: "Agencies",
    sizeRanges: ["51-200"],
  });
  assert.deepEqual(await published(who.workspaceId), [event(2), event(3)]);
});
