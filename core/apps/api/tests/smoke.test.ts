// identity's smoke step (core/modules/identity/tests/smoke.ts), which `pnpm smoke` runs after the
// health check, against an api started here on the Better Auth adapter and identity's hooks, in a
// schema of the worktree's database with no organization yet, where the step stops; after the first
// `pnpm invite`, the step's invite, the link through the app-mail port and Mailpit, and GET /v1/me
// lists the Owner membership. A fresh address, as Mailpit is shared; `pnpm smoke` uses SMOKE_EMAIL.
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { runInvite, smokeSignIn, useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger } from "@whytide/platform";
import { authPort, getAdapter } from "@whytide/providers";
import { useAuthDatabase } from "@whytide/providers/auth/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import type { ModuleLoader } from "../src/modules.ts";
import { WINDOW_MS } from "../src/protection/rate-limit.ts";
import { type Api, start } from "../src/start.ts";

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
const modules: ModuleLoader[] = [
  { name: "tenancy", load: () => import("@whytide/tenancy") },
  { name: "identity", load: () => import("@whytide/identity") },
];
let api: Api;

before(async () => {
  useAuthDatabase(asRole("app"));
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  const minute = (Math.floor(Date.now() / WINDOW_MS) + randomInt(1_000, 1_000_000)) * WINDOW_MS;
  api = await start({
    port: 0,
    auth: await getAdapter(authPort, "better-auth"),
    log: createLogger({ destination: collectLogs().destination }),
    modules,
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
    now: () => minute,
  });
});
after(() => api?.close());

test("the smoke step stops on a database with no organization; after the first invite it signs in as an Owner", async () => {
  const lines: string[] = [];
  const say = (line: string) => lines.push(line);
  const email = `smoke-${randomUUID()}@example.test`;
  await assert.rejects(smokeSignIn(api.url, email, say), /no organization/);
  assert.equal(await runInvite([`first-${randomUUID()}@example.test`], say), 0);
  await smokeSignIn(api.url, email, say);
  const codes = lines.map((line) => line.split(":")[0]);
  assert.deepEqual(codes, ["organization_created", "invite_created", "invite_created", "smoke"]);
});
