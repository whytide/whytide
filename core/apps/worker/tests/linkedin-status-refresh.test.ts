// linkedin's status refresh (alpha-p10-130; core/modules/linkedin/README.md "Worker"), on the slice's
// Temporal and a schema of its database, the LinkedIn fake bound: the host started with linkedin from
// its build, as the worker loads it. linkedin_status_refresh, global, refreshes every account with a
// reference, in any workspace, and leaves one without; its schedule is hourly. A Refresh status
// press, the route's event, reaches linkedin's subscriber through the outbox, which runs
// linkedin_refresh_account for the account by the event's id: the status is stored, and a second
// delivery starts no second run. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, Connection } from "@temporalio/client";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  collectLogs,
  createLogger,
  loadMasterKeys,
  newMasterKey,
  servicePrincipal,
} from "@whytide/platform";
import type { LinkedinFake } from "@whytide/providers";
import { workerConfig } from "../src/config.ts";
import { moduleLoaders } from "../src/modules.generated.ts";

withTestDb();
// The fake, whatever the environment names: set before anything reads the providers' config.
process.env.PROVIDER_LINKEDIN = "fake";
const { getAdapter, linkedinPort } = await import("@whytide/providers");
const { start } = await import("../src/start.ts");
// linkedin and tenancy by their builds' paths, as the host loads a module: the worker lists neither.
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
type Settings = { providerAccountRef?: string };
const linkedin: {
  useLinkedinClient(client: unknown): void;
  useSecretKeys(keys: unknown): void;
  createConnectedAccount(workspace: string, settings?: Settings): Promise<{ id: string }>;
} = await built("linkedin/dist/testing/index.js");
const accounts: { requestRefresh(id: string): Promise<unknown> } = await built(
  "linkedin/dist/domain/accounts.js",
);
type Tenant = { workspace: { id: string } };
const tenancy: {
  useTenancyClient(client: unknown): void;
  createTwoWorkspaces(): Promise<readonly [Tenant, Tenant]>;
} = await built("tenancy/dist/testing/index.js");

const app = asRole("app");
linkedin.useLinkedinClient(app);
linkedin.useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
tenancy.useTenancyClient(app);
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const log = createLogger({ destination: collectLogs().destination });
const SCHEDULE = "linkedin.status_refresh";
/** The schedules the host's start upserts for linkedin, both deleted around a test. */
const SCHEDULES = [SCHEDULE, "linkedin.daily"];

/** `fn` with the host started, linkedin alone, on a queue of its own; closed after, the schedules deleted. */
async function withHost(fn: (temporal: Client, taskQueue: string) => Promise<void>) {
  const connection = await Connection.connect({ address: workerConfig.TEMPORAL_ADDRESS });
  const temporal = new Client({ connection, namespace: workerConfig.TEMPORAL_NAMESPACE });
  const deleteSchedules = () =>
    Promise.all(
      SCHEDULES.map((id) =>
        temporal.schedule
          .getHandle(id)
          .delete()
          .catch(() => undefined),
      ),
    );
  const taskQueue = `test-${randomUUID()}`;
  const modules = moduleLoaders.filter(({ name }) => name === "linkedin");
  await deleteSchedules();
  const host = await start({
    modules,
    taskQueue,
    healthPort: 0,
    client: app,
    log,
    schedules: "off",
  });
  try {
    await fn(temporal, taskQueue);
  } finally {
    await host.close();
    await deleteSchedules();
    await connection.close();
  }
}

/** A connected account with a reference the fake answers `status` for. */
async function account(workspaceId: string, status: "connected" | "credentials_required") {
  const providerAccountRef = `fake-account-${randomUUID()}`;
  fake.emitWebhook(`account.${status}`, providerAccountRef); // the vendor's side only
  return linkedin.createConnectedAccount(workspaceId, { providerAccountRef });
}

const statusOf = async (id: string) =>
  (await app.senderAccount.findUniqueOrThrow({ where: { id } })).status;

/** The first truthy answer of `probe`, asked every 50 ms for 20 seconds at most. */
async function until<T>(probe: () => Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const answer = await probe();
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error("until: no answer in 20 seconds");
    await sleep(50);
  }
}

test("linkedin_status_refresh refreshes every account with a reference, in any workspace, and leaves one without; the schedule linkedin.status_refresh starts it hourly", () =>
  withHost(async (temporal, taskQueue) => {
    const [a, b] = await tenancy.createTwoWorkspaces();
    const asked = await account(a.workspace.id, "credentials_required");
    const other = await account(b.workspace.id, "connected");
    const bare = await linkedin.createConnectedAccount(a.workspace.id);
    const workflowId = `linkedin_status_refresh-${randomUUID()}`;
    const run = temporal.workflow.execute("linkedin_status_refresh", {
      args: [{}],
      taskQueue,
      workflowId,
    });
    assert.deepEqual(await run, { accounts: 2, failed: 0 });
    const statuses = await Promise.all([asked, other, bare].map(({ id }) => statusOf(id)));
    assert.deepEqual(statuses, ["credentials_required", "connected", "connected"]);

    const described = await temporal.schedule.getHandle(SCHEDULE).describe();
    const every = described.spec.intervals?.map((interval) => interval.every);
    assert.deepEqual(
      [described.action.workflowType, every, described.state.paused],
      ["linkedin_status_refresh", [3_600_000], true],
    );
  }));

test("a Refresh status press: the subscriber runs linkedin_refresh_account by the event's id, the status is stored, and a second delivery starts no second run", () =>
  withHost(async (temporal) => {
    const [a] = await tenancy.createTwoWorkspaces();
    const workspaceId = a.workspace.id;
    const { id } = await account(workspaceId, "credentials_required");
    const tenant = { workspaceId, principal: servicePrincipal("test") };
    await withTenant(tenant, () => accounts.requestRefresh(id), { client: app });
    const event = await app.outboxEntry.findFirstOrThrow({
      where: { workspaceId, eventName: "linkedin.status_refresh_requested" },
    });
    assert.deepEqual(event.payload, { sender_account_id: id });
    const delivered = async () =>
      (await app.outboxEntry.findUniqueOrThrow({ where: { id: event.id } })).deliveredAt;
    await until(delivered);
    const run = temporal.workflow.getHandle(`linkedin.status_refresh:${workspaceId}:${event.id}`);
    assert.deepEqual(await run.result(), { status: "credentials_required" });
    assert.equal(await statusOf(id), "credentials_required");

    const { runId } = await run.describe();
    await app.outboxEntry.update({ where: { id: event.id }, data: { deliveredAt: null } });
    await until(delivered);
    assert.equal((await run.describe()).runId, runId);
  }));
