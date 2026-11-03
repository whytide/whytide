// GET /v1/me end to end (alpha-p3-010; core/modules/tenancy/README.md "GET /v1/me"): the host started
// with the tenancy module, mounted through its `accountApi` export, on the fake authentication adapter,
// in a schema of the worktree's database, answering real HTTP. It lives in the host's tests: a module
// never imports a host, its tests included. Also tenancy's FEEDBACK_URL at start (alpha-p10-040).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger, isAppError } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createMembership,
  createTwoWorkspaces,
  type TestTenant,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import { loadModules } from "../src/modules.ts";
import { type Api, start } from "../src/start.ts";

const db = withTestDb();
useTenancyClient(asRole("app"));
// Unset, whatever .env.local says: tenancy reads it once, as start() loads the module below.
process.env.FEEDBACK_URL = "";
let api: Api;

/** The migrations of the host's start: this file's schema. */
function migrationsUrl(): string {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  return migrations.toString();
}

before(async () => {
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [{ name: "tenancy", load: () => import("@whytide/tenancy") }],
    migrations: { url: migrationsUrl() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

/** GET /v1/me, signed in as the user when one is given. */
async function me(userId?: string) {
  const session = userId === undefined ? [] : signInAs(userId);
  const cookie = session.map(({ name, value }) => `${name}=${value}`).join("; ");
  const res = await fetch(new URL("/v1/me", api.url), { headers: cookie ? { cookie } : {} });
  return { status: res.status, body: (await res.json()) as unknown };
}

const user = ({ user: { id, email, displayName } }: TestTenant) => ({
  id,
  email,
  displayName,
  locale: null,
});
const listing = ({ workspace, organization }: TestTenant, role: string) => ({
  workspaceId: workspace.id,
  slug: workspace.slug,
  name: workspace.name,
  organizationName: organization.name,
  role,
});

test("GET /v1/me: 401 without a session; with one, the user and exactly their memberships with roles, feedbackUrl null while unset", async () => {
  assert.deepEqual(await me(), { status: 401, body: { code: "auth_session_invalid" } });
  const [a, b] = await createTwoWorkspaces();
  await createMembership({ userId: a.user.id, workspaceId: b.workspace.id, role: "Member" });
  const memberships = [listing(a, "Owner"), listing(b, "Member")];
  const body = { user: user(a), memberships, feedbackUrl: null };
  assert.deepEqual(await me(a.user.id), { status: 200, body });
  const own = { user: user(b), memberships: [listing(b, "Owner")], feedbackUrl: null };
  assert.deepEqual(await me(b.user.id), { status: 200, body: own });
});

test("a FEEDBACK_URL that is not an https URL stops the start with config_invalid, which names it", () => {
  const start = new URL("../src/start.js", import.meta.url).href;
  const tenancy = import.meta.resolve("@whytide/tenancy");
  const script = [
    `const { start } = await import(${JSON.stringify(start)});`,
    `const modules = [{ name: "tenancy", load: () => import(${JSON.stringify(tenancy)}) }];`,
    `await start({ port: 0, modules, migrations: { url: ${JSON.stringify(migrationsUrl())} } })`,
    "  .then(() => process.exit(0), () => process.exit(1));",
  ].join("\n");
  for (const value of ["http://feedback.example.com/alpha", "javascript:alert(1)"]) {
    const env = { ...process.env, FEEDBACK_URL: value };
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env,
      encoding: "utf8",
    });
    assert.equal(run.status, 1, run.stderr);
    const lines = run.stdout.split("\n").filter((line) => line.startsWith("{"));
    const fatal = lines.map((line) => JSON.parse(line)).find(({ level }) => level === "fatal");
    const variables = ["FEEDBACK_URL: an https URL"];
    const details = { block: "modules/tenancy", variables };
    assert.deepEqual([fatal?.err?.code, fatal?.err?.details], ["config_invalid", details], value);
    assert.ok(!run.stdout.includes(value), "the value is never logged");
  }
});

test("a module whose accountApi is its api is refused at start: one class, one path", async () => {
  class Both {}
  const load = async () => ({ api: Both, accountApi: Both });
  await assert.rejects(loadModules([{ name: "both", load }]), (error: unknown) => {
    assert.ok(isAppError(error));
    const details = { module: "both", field: "accountApi" };
    assert.deepEqual([error.code, error.details], ["module_invalid", details]);
    return true;
  });
});
