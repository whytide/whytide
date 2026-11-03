// linkedin's member id after a connect (beta-p1-070; core/modules/linkedin/README.md "Worker"), on the
// slice's Temporal and a schema of its database, the LinkedIn fake bound: the host started with
// linkedin from its build, as the worker loads it. A connect's linkedin.sender_account_connected
// reaches linkedin's subscriber through the outbox, which runs linkedin_refresh_account by the event's
// id: the member id's keyed hash is stored, never the id. The same LinkedIn account connected in a
// second workspace ends that account disconnected (sender_account_in_use), answered as a result and
// not retried, the first untouched; a reconnect with another member id replaces the account; without
// the key nothing is stored, logged once per run. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, Connection, type WorkflowHandle } from "@temporalio/client";
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
const linkedin: {
  useLinkedinClient(client: unknown): void;
  useSecretKeys(keys: unknown): void;
  useHashKey(key: string | null | undefined): void;
} = await built("linkedin/dist/testing/index.js");
type Tenant = { workspaceId: string; principal: ReturnType<typeof servicePrincipal> };
const accounts: {
  startConnect(tenant: Tenant, input: Record<string, unknown>): Promise<{ url: string }>;
  disconnect(id: string): Promise<void>;
} = await built("linkedin/dist/domain/accounts.js");
const status: {
  completeConnect(event: { providerAccountRef: string; providerRef: string }): Promise<void>;
} = await built("linkedin/dist/domain/status.js");
type Workspace = { workspace: { id: string } };
const tenancy: {
  useTenancyClient(client: unknown): void;
  createTwoWorkspaces(): Promise<readonly [Workspace, Workspace]>;
} = await built("tenancy/dist/testing/index.js");

const app = asRole("app");
linkedin.useLinkedinClient(app);
linkedin.useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
tenancy.useTenancyClient(app);
/** A test key, never a real one. */
const KEY = "linkedin-member-id-test-key-0123456789";
linkedin.useHashKey(KEY);
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const logs = collectLogs();
const log = createLogger({ destination: logs.destination });
const principal = servicePrincipal("test");
const DISCLOSURE = { acknowledged: true, disclosureVersion: 2, personalAccount: true };
const CONNECTED = "linkedin.sender_account_connected";

/**
 * `fn` with the host started, linkedin alone, on a queue of its own; closed after. The schedule it
 * upserts stays: linkedin-status-refresh.test.ts, which may run at the same time, reads it.
 */
async function withHost(fn: (temporal: Client, taskQueue: string) => Promise<void>) {
  const connection = await Connection.connect({ address: workerConfig.TEMPORAL_ADDRESS });
  const temporal = new Client({ connection, namespace: workerConfig.TEMPORAL_NAMESPACE });
  const modules = moduleLoaders.filter(({ name }) => name === "linkedin");
  const taskQueue = `test-${randomUUID()}`;
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
    await connection.close();
  }
}

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

/**
 * The owner connects the workspace's account and the vendor pairs it with `ref`, a new LinkedIn
 * account unless given; then the refresh the connect's event starts: the account, its ref, its run.
 */
async function connect(
  temporal: Client,
  workspaceId: string,
  ref = `fake-account-${randomUUID()}`,
) {
  const tenant = { workspaceId, principal };
  const where = { workspaceId, eventName: CONNECTED };
  const earlier = (await app.outboxEntry.findMany({ where })).map(({ id }) => id);
  const returnTo = `https://app.whytide.test/w/${workspaceId}/linkedin`;
  const { url } = await accounts.startConnect(tenant, { timeZone: "UTC", ...DISCLOSURE, returnTo });
  fake.emitWebhook("account.connected", ref); // the vendor's side only
  const providerRef = new URL(url).searchParams.get("link") ?? "";
  await status.completeConnect({ providerAccountRef: ref, providerRef });
  const event = await app.outboxEntry.findFirstOrThrow({
    where: { ...where, id: { notIn: earlier } },
  });
  await until(
    async () => (await app.outboxEntry.findUniqueOrThrow({ where: { id: event.id } })).deliveredAt,
  );
  const run = temporal.workflow.getHandle(`linkedin.status_refresh:${workspaceId}:${event.id}`);
  const row = await app.senderAccount.findFirstOrThrow({ where: { workspaceId } });
  return { id: row.id, ref, run, result: await run.result() };
}

const rowOf = (id: string) => app.senderAccount.findUniqueOrThrow({ where: { id } });
const hashOf = (memberRef: string) =>
  createHmac("sha256", KEY).update(`linkedin:${memberRef}`).digest("hex");
/** The member id the fake answers for the LinkedIn account `ref`. */
async function memberOf(ref: string): Promise<string> {
  const { memberRef } = await fake.getAccountStatus(ref);
  assert.ok(memberRef, "the fake answers a member id");
  return memberRef;
}
const eventsOf = async (workspaceId: string, eventName: string) =>
  (await app.outboxEntry.findMany({ where: { workspaceId, eventName } })).map(
    ({ payload }) => payload,
  );
/** The run's history as text, its payloads decoded: what Temporal keeps of its inputs and results. */
async function historyText(run: WorkflowHandle): Promise<string> {
  const texts: string[] = [];
  const walk = (value: unknown): void => {
    if (value instanceof Uint8Array) texts.push(Buffer.from(value).toString("utf8"));
    else if (typeof value === "string") texts.push(value);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk((await run.fetchHistory()).events);
  return texts.join("\n");
}

test("a connect stores the member id's keyed hash through the subscriber and the refresh; the same LinkedIn account connected in a second workspace ends that account disconnected, its references cleared, one sender_account_in_use row and its disconnect event, answered as a result and never retried; the first account is untouched; no row, event, log line or workflow input holds the id", () =>
  withHost(async (temporal) => {
    const [a, b] = await tenancy.createTwoWorkspaces();
    const first = await connect(temporal, a.workspace.id);
    assert.deepEqual(first.result, { status: "connected" });
    const member = await memberOf(first.ref);
    const kept = await rowOf(first.id);
    assert.equal(kept.memberIdHash, hashOf(member));

    const second = await connect(temporal, b.workspace.id, first.ref);
    assert.deepEqual(second.result, { status: "disconnected", refused: "sender_account_in_use" });
    const ended = await rowOf(second.id);
    assert.deepEqual(
      [ended.status, ended.providerAccountRef, ended.providerAccountRefHash, ended.providerLinkRef],
      ["disconnected", null, null, null],
    );
    assert.equal(ended.memberIdHash, null, "the refused hash is not stored");
    const logged = await app.senderActionLog.findMany({ where: { senderAccountId: second.id } });
    assert.deepEqual(
      logged.map(({ kind, outcome }) => [kind, outcome]),
      [["status_check", "sender_account_in_use"]],
    );
    const disconnected = await eventsOf(b.workspace.id, "linkedin.sender_account_disconnected");
    assert.deepEqual(disconnected, [{ sender_account_id: second.id }]);
    const { events } = await second.run.fetchHistory();
    const started = (events ?? []).map((event) => event.activityTaskStartedEventAttributes);
    const attempts = started.flatMap((attributes) => attributes?.attempt ?? []);
    assert.deepEqual(attempts, [1], "one attempt: no retry");
    assert.deepEqual(await rowOf(first.id), kept, "the first workspace's account is untouched");

    const rows = await app.$queryRaw<{ line: string }[]>`
      SELECT row_to_json(t)::text AS line FROM sender_accounts t
      UNION ALL SELECT row_to_json(t)::text FROM sender_action_log t
      UNION ALL SELECT row_to_json(t)::text FROM outbox t`;
    assert.ok(
      rows.length > 0 && rows.every(({ line }) => !line.includes(member)),
      "no row holds the id",
    );
    assert.ok(
      logs.raw.every((line) => !line.includes(member)),
      "no log line holds it",
    );
    for (const { id, run } of [first, second]) {
      const history = await historyText(run);
      assert.ok(history.includes(id), "the payloads are decoded");
      assert.ok(!history.includes(member), "no workflow input or result holds it");
    }
  }));

test("a reconnect that brings another member id replaces the account: the targets back to 5 and 10, the disclosure to accept again, linkedin.account_replaced once; a reconnect of the same LinkedIn account changes nothing", () =>
  withHost(async (temporal) => {
    const [a] = await tenancy.createTwoWorkspaces();
    const workspaceId = a.workspace.id;
    const first = await connect(temporal, workspaceId);
    const raised = { inviteTarget: 12, messageTarget: 30, rampUpdatedOn: "2026-10-28" };
    await app.senderAccount.update({ where: { id: first.id }, data: raised });
    const reconnect = async (ref?: string) => {
      await withTenant({ workspaceId, principal }, () => accounts.disconnect(first.id), {
        client: app,
      });
      return connect(temporal, workspaceId, ref);
    };

    assert.deepEqual((await reconnect(first.ref)).result, { status: "connected" });
    const same = await rowOf(first.id);
    assert.deepEqual(
      [same.inviteTarget, same.messageTarget, same.rampUpdatedOn, same.disclosureVersion],
      [12, 30, "2026-10-28", 2],
    );
    assert.equal(same.memberIdHash, hashOf(await memberOf(first.ref)));
    assert.deepEqual(await eventsOf(workspaceId, "linkedin.account_replaced"), []);

    const replaced = await reconnect();
    assert.deepEqual(replaced.result, { status: "connected" });
    const row = await rowOf(first.id);
    assert.deepEqual(
      [row.inviteTarget, row.messageTarget, row.rampUpdatedOn, row.disclosureVersion],
      [5, 10, null, 1],
    );
    assert.equal(row.personalAccountConfirmedAt, null);
    assert.equal(row.memberIdHash, hashOf(await memberOf(replaced.ref)));
    const events = await eventsOf(workspaceId, "linkedin.account_replaced");
    assert.deepEqual(events, [{ sender_account_id: first.id }]);
  }));

test("without LINKEDIN_HASH_KEY a connect's refresh stores no member id and the account stays connected; linkedin_hash_key_missing is logged once per run, once for an hourly run over several accounts", () =>
  withHost(async (temporal, taskQueue) => {
    linkedin.useHashKey(null);
    try {
      const [a, b] = await tenancy.createTwoWorkspaces();
      const missing = () =>
        logs.lines().filter(({ code }) => code === "linkedin_hash_key_missing").length;
      const before = missing();
      const connected = [
        await connect(temporal, a.workspace.id),
        await connect(temporal, b.workspace.id),
      ];
      for (const account of connected) {
        assert.deepEqual(account.result, { status: "connected" });
        assert.equal((await rowOf(account.id)).memberIdHash, null);
      }
      assert.equal(missing(), before + 2, "one line for each run");

      const workflowId = `linkedin_status_refresh-${randomUUID()}`;
      const hourly = { args: [{}], taskQueue, workflowId };
      const swept = await temporal.workflow.execute("linkedin_status_refresh", hourly);
      const { accounts: refreshed, failed } = swept as { accounts: number; failed: number };
      assert.ok(refreshed >= 2 && failed === 0, "every account with a reference refreshed");
      assert.equal(missing(), before + 3, "one line for the hourly run");
      const hashes = await Promise.all(
        connected.map(async ({ id }) => (await rowOf(id)).memberIdHash),
      );
      assert.deepEqual(hashes, [null, null]);
    } finally {
      linkedin.useHashKey(KEY);
    }
  }));
