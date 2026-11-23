// email's worker side (gamma-p1-010; core/modules/email/README.md "Worker"), on the mailbox fake, a
// schema of the slice's database and its Temporal, the fake set before the providers load: a
// member's disconnect, or a removed member's, delivered by the outbox, starts email_revoke_mailbox
// once, which revokes the mailbox's refresh token at the fake and nulls the blob; delivered again it
// starts no second run. A revoke the provider keeps refusing nulls the blob anyway and logs
// email_revoke_failed. A mailbox reconnected since, or disconnected again at another time, keeps its
// tokens, also when the reconnect lands between the revoke's check and its token read.
// withMailboxTokens refreshes an access token close to its expiry and seals the rotated refresh token
// again; a revoked grant disconnects the mailbox with token_revoked, an answer, and starts no
// revoke. No history or log line holds a token. The hourly check and the owner's mail come with
// gamma-p1-015. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

process.env.PROVIDER_MAILBOX = "fake";

const { historyToJSON } = await import("@temporalio/common/lib/proto-utils.js");
const { NativeConnection, Worker } = await import("@temporalio/worker");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { bindWorkflowStarter, collectLogs, createLogger, loadMasterKeys, newMasterKey } = platform;
const { getAdapter, mailboxPort, messageIdFor } = await import("@whytide/providers");
const { hostActivity } = await import("../src/activities.ts");
const { workerConfig } = await import("../src/config.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules, startModules } = await import("../src/modules.ts");
const { startOutboxLoop } = await import("../src/outbox.ts");
const { workflowStarter } = await import("../src/starter.ts");
const { IDENTITY, metricSinks, workflowBundle } = await import("../src/temporal.ts");
const { withTestWorkflowEnvironment } = await import("../testing/index.ts");

// The modules by their builds' paths, as the loader imports them: the worker depends on neither.
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
type Email = typeof import("../../../modules/email/dist/index.js");
type EmailTesting = typeof import("../../../modules/email/dist/testing/index.js");
type Decrypt = typeof import("../../../modules/email/dist/workflows/decrypt.js");
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
const { disconnectMailbox }: Email = await built("email/dist/index.js");
const email: EmailTesting = await built("email/dist/testing/index.js");
const { withMailboxTokens }: Decrypt = await built("email/dist/workflows/decrypt.js");
const tenancy: TenancyTesting = await built("tenancy/dist/testing/index.js");
type MailboxFake = import("@whytide/providers").MailboxFake;
type TenantClient = import("@whytide/db").TenantClient;
type Handle = import("@temporalio/client").WorkflowHandle;
type Reason = "user" | "member_removed";
type RevokeInput = { workspaceId: string; mailboxId: string; disconnectedAt: string };

withTestDb();
const app = asRole("app");
email.useEmailClient(app);
tenancy.useTenancyClient(app);
email.useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
const env = withTestWorkflowEnvironment();
const logs = collectLogs();
const log = createLogger({ destination: logs.destination });
const loaded = await loadModules(moduleLoaders.filter(({ name }) => name === "email"));
await startModules(loaded, log);
const fake = (await getAdapter(mailboxPort, "fake")) as unknown as MailboxFake;
const principal = platform.servicePrincipal("worker");
const REVOKE = "email_revoke_mailbox";
const DISCONNECTED = "email.mailbox_disconnected";
/** What the fake's tokens start with: none may be in a history or a log line. */
const TOKEN = /fake-(refresh|access)-/;

/** email's workflows on a worker of the test's queue, and the host's starter on that queue. */
let connection: import("@temporalio/worker").NativeConnection | undefined;
let worker: import("@temporalio/worker").Worker | undefined;
let running: Promise<void> | undefined;
let unbind: (() => void) | undefined;
before(async () => {
  const activities = Object.fromEntries(
    [...loaded.activities].map(([name, definition]) => {
      return [name, hostActivity(name, definition, { client: app, log })];
    }),
  );
  connection = await NativeConnection.connect({ address: workerConfig.TEMPORAL_ADDRESS });
  worker = await Worker.create({
    connection,
    namespace: env.namespace,
    taskQueue: env.taskQueue,
    identity: IDENTITY,
    workflowBundle: await workflowBundle(env.workflowsPath),
    activities,
    sinks: metricSinks(),
  });
  running = worker.run();
  unbind = bindWorkflowStarter(workflowStarter(env.client, loaded.workflows, env.taskQueue));
});
after(async () => {
  unbind?.();
  worker?.shutdown();
  await running;
  await connection?.close();
});
beforeEach(() => fake.reset());

/** The first truthy answer of `probe`, asked every 50 ms for 30 seconds at most. */
async function until<T>(probe: () => Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const answer = await probe();
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error("until: no answer in 30 seconds");
    await sleep(50);
  }
}

/** What an activity's context gives withMailboxTokens: the workspace and its tenant runs. */
const contextOf = (workspaceId: string) => ({
  workspaceId,
  tenant: <T>(fn: (tx: TenantClient) => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app }),
});

/** A connected mailbox of a new workspace's, on the fake's grant. */
async function connected(options: { accessExpiresAt?: Date } = {}) {
  const [{ workspace }] = await tenancy.createTwoWorkspaces();
  const { id: mailboxId } = await email.createConnectedMailbox(workspace.id, options);
  return { workspaceId: workspace.id, mailboxId };
}

const rowOf = (mailboxId: string) => app.mailbox.findUniqueOrThrow({ where: { id: mailboxId } });
const callsOf = (method: string) => fake.recordedCalls.filter((call) => call.method === method);

/** The disconnect, in a run of the workspace, at `at`. */
async function disconnect(workspaceId: string, mailboxId: string, reason: Reason, at = new Date()) {
  const input = { workspaceId, mailboxId, reason, at };
  const answer = await contextOf(workspaceId).tenant(() => disconnectMailbox(input));
  assert.deepEqual(answer, { disconnected: true });
  return at;
}

/** The reconnect as the callback leaves the same address's row: connected again, at a new time. */
async function reconnect(mailboxId: string) {
  await app.mailbox.update({
    where: { id: mailboxId },
    data: {
      status: "connected",
      disconnectedReason: null,
      disconnectedAt: null,
      connectedAt: new Date(),
    },
  });
}

/** The refresh token sealed in the mailbox's blob, read through the worker's entry. */
async function refreshTokenOf(workspaceId: string, mailboxId: string) {
  const read = async ({ refreshToken }: { refreshToken: string }) => refreshToken;
  const answer = await withMailboxTokens(contextOf(workspaceId), mailboxId, read, "never");
  assert.ok(answer.ok);
  return answer.value;
}

/** The run's history, its payloads decoded to text. */
async function historyOf(handle: Handle) {
  const decoded: string[] = [];
  const raw = JSON.stringify(JSON.parse(historyToJSON(await handle.fetchHistory())), (_, value) => {
    const data = (value as { metadata?: unknown; data?: unknown } | null)?.data;
    if (typeof data === "string" && (value as { metadata?: unknown }).metadata) {
      decoded.push(Buffer.from(data, "base64").toString("utf8"));
    }
    return value;
  });
  return [raw, ...decoded].join("\n");
}

/** email_revoke_mailbox started on the test's queue under an id history:record takes: its end. */
async function revokeRun(input: RevokeInput) {
  const workflowId = `${REVOKE}-${randomUUID()}`;
  const handle = await env.client.workflow.start(REVOKE, {
    args: [input],
    taskQueue: env.taskQueue,
    workflowId,
  });
  return { handle, result: await handle.result() };
}

test("a member's disconnect, and a removed member's, delivered by the outbox, start email_revoke_mailbox once each: the fake takes the revoke of the sealed refresh token, which answers mailbox_token_revoked from then on, and the blob is nulled; delivered again, no second run; no history holds a token", async () => {
  const outbox = startOutboxLoop(app, log);
  try {
    const runs: { mailboxId: string; handle: Handle }[] = [];
    for (const reason of ["user", "member_removed"] as const) {
      const { workspaceId, mailboxId } = await connected();
      const refreshToken = await refreshTokenOf(workspaceId, mailboxId);
      const at = await disconnect(workspaceId, mailboxId, reason);
      const id = `email.revoke:${workspaceId}:${mailboxId}:${at.toISOString()}`;
      const handle = env.client.workflow.getHandle(id);
      await until(() => handle.describe().catch(() => null));
      assert.deepEqual(await handle.result(), { outcome: "revoked", dropped: true }, reason);
      const row = await rowOf(mailboxId);
      const state = [row.status, row.disconnectedReason, row.oauthTokenRef];
      assert.deepEqual(state, ["disconnected", reason, null], reason);
      assert.deepEqual(callsOf("revokeAccess").at(-1)?.input, { refreshToken });
      await assert.rejects(fake.refreshAccess({ refreshToken }), {
        code: "mailbox_token_revoked",
      });
      assert.doesNotMatch(await historyOf(handle), TOKEN);
      runs.push({ mailboxId, handle });
    }
    assert.equal(callsOf("revokeAccess").length, 2, "one revoke each");

    const [first] = runs;
    assert.ok(first);
    const entries = await app.outboxEntry.findMany({ where: { eventName: DISCONNECTED } });
    const entry = entries.find(
      (e) => (e.payload as { mailbox_id?: string }).mailbox_id === first.mailboxId,
    );
    assert.ok(entry);
    assert.deepEqual(entry.payload, { mailbox_id: first.mailboxId, reason: "user" });
    const { runId } = await first.handle.describe();
    await app.outboxEntry.update({ where: { id: entry.id }, data: { deliveredAt: null } });
    await until(async () => {
      return (await app.outboxEntry.findUniqueOrThrow({ where: { id: entry.id } })).deliveredAt;
    });
    assert.equal((await first.handle.describe()).runId, runId, "the same run, none after it");
    assert.equal(callsOf("revokeAccess").length, 2, "no second revoke");
  } finally {
    await outbox.stop();
  }
});

test("a revoke the provider keeps refusing: after its five attempts the run nulls the blob anyway and answers failed, and the worker logs email_revoke_failed with the mailbox's id; no log line or history holds a token", async () => {
  const { workspaceId, mailboxId } = await connected();
  const at = await disconnect(workspaceId, mailboxId, "user");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    fake.failNext("mailbox_provider_error", { status: 503, retryAfterSec: 0.05 });
  }
  const { handle, result } = await revokeRun({
    workspaceId,
    mailboxId,
    disconnectedAt: at.toISOString(),
  });
  assert.deepEqual(result, { outcome: "failed", dropped: true });
  assert.equal((await rowOf(mailboxId)).oauthTokenRef, null);
  assert.equal(callsOf("revokeAccess").length, 5, "five attempts");
  const lines = logs.lines().filter((line) => line.code === "email_revoke_failed");
  assert.deepEqual(
    lines.map((line) => [line.level, line.mailbox_id]),
    [["warn", mailboxId]],
  );
  assert.doesNotMatch(JSON.stringify(logs.lines()), TOKEN);
  assert.doesNotMatch(await historyOf(handle), TOKEN);
});

test("a mailbox reconnected before its revoke ran keeps its tokens: the run answers skipped and calls no revoke; disconnected again, the first disconnect's run still skips, and the second's revokes", async () => {
  const { workspaceId, mailboxId } = await connected();
  const first = await disconnect(workspaceId, mailboxId, "user");
  const { oauthTokenRef } = await rowOf(mailboxId);
  await reconnect(mailboxId);
  const input = { workspaceId, mailboxId, disconnectedAt: first.toISOString() };
  assert.deepEqual((await revokeRun(input)).result, { outcome: "skipped", dropped: false });
  const second = await disconnect(workspaceId, mailboxId, "user", new Date(first.getTime() + 1));
  assert.deepEqual((await revokeRun(input)).result, { outcome: "skipped", dropped: false });
  assert.deepEqual((await rowOf(mailboxId)).oauthTokenRef, oauthTokenRef, "the tokens kept");
  assert.equal(callsOf("revokeAccess").length, 0);
  const { result } = await revokeRun({ ...input, disconnectedAt: second.toISOString() });
  assert.deepEqual(result, { outcome: "revoked", dropped: true });
  assert.equal((await rowOf(mailboxId)).oauthTokenRef, null);
});

test("a mailbox reconnected after the revoke's check and before its token read: the read holds the same disconnect, so the activity answers skipped and the reconnect's tokens are never revoked", async () => {
  const { workspaceId, mailboxId } = await connected();
  const at = await disconnect(workspaceId, mailboxId, "user");
  const { oauthTokenRef } = await rowOf(mailboxId);
  const revoke = loaded.activities.get("email_revoke_token");
  assert.ok(revoke !== undefined && revoke.scope === undefined);
  // The activity's context as the host builds it, the reconnect committed before its second run.
  const { tenant } = contextOf(workspaceId);
  let runs = 0;
  const context = {
    workspaceId,
    workflowId: `${REVOKE}-${randomUUID()}`,
    attempt: 1,
    tenant: async <T>(fn: (tx: TenantClient) => Promise<T>) => {
      runs += 1;
      if (runs === 2) await reconnect(mailboxId);
      return tenant(fn);
    },
  };
  const input = { workspaceId, mailboxId, disconnectedAt: at.toISOString() };
  assert.deepEqual(await revoke.run(input, context), { outcome: "skipped" });
  assert.equal(runs, 2, "the check, then the token read");
  assert.equal(callsOf("revokeAccess").length, 0, "no revoke");
  const row = await rowOf(mailboxId);
  assert.equal(row.status, "connected");
  assert.deepEqual(row.oauthTokenRef, oauthTokenRef, "the tokens kept");
});

test("withMailboxTokens refreshes an access token close to its expiry first: the rotated refresh token is sealed again in another blob and the old one answers mailbox_token_revoked; a fresh access token is not refreshed", async () => {
  const soon = new Date(Date.now() + 30_000); // inside ACCESS_MARGIN_MS
  const { workspaceId, mailboxId } = await connected({ accessExpiresAt: soon });
  const before = await rowOf(mailboxId);
  const old = await refreshTokenOf(workspaceId, mailboxId);
  const answer = await withMailboxTokens(contextOf(workspaceId), mailboxId, async (t) => t);
  assert.ok(answer.ok);
  assert.notEqual(answer.value.refreshToken, old, "rotated");
  assert.ok(Date.parse(answer.value.expiresAt) > soon.getTime());
  const after = await rowOf(mailboxId);
  assert.notDeepEqual(after.oauthTokenRef, before.oauthTokenRef, "sealed again");
  assert.ok((after.tokenCheckedAt?.getTime() ?? 0) > (before.tokenCheckedAt?.getTime() ?? 0));
  assert.equal(await refreshTokenOf(workspaceId, mailboxId), answer.value.refreshToken);
  await assert.rejects(fake.refreshAccess({ refreshToken: old }), {
    code: "mailbox_token_revoked",
  });
  const refreshes = callsOf("refreshAccess").length;
  const ran = await withMailboxTokens(contextOf(workspaceId), mailboxId, async () => "ran");
  assert.deepEqual(ran, { ok: true, value: "ran" });
  assert.equal(callsOf("refreshAccess").length, refreshes, "no refresh");
});

test("a grant the person revoked at the provider, met by a refresh or by a read: withMailboxTokens answers token_revoked, never throws, and the mailbox turns disconnected with token_revoked, its blob nulled at once; the event, delivered, starts no revoke", async () => {
  const [{ workspace }] = await tenancy.createTwoWorkspaces();
  const workspaceId = workspace.id;
  const refreshed = await email.createConnectedMailbox(workspaceId);
  const read = await email.createConnectedMailbox(workspaceId);
  fake.revoke();
  const context = contextOf(workspaceId);
  const ran = async () => "ran";
  assert.deepEqual(await withMailboxTokens(context, refreshed.id, ran, "now"), {
    ok: false,
    reason: "token_revoked",
  });
  const messageId = messageIdFor({ idempotencyKey: "step-1", domain: "example.com" });
  const found = await withMailboxTokens(
    context,
    read.id,
    ({ accessToken }, mailbox) => mailbox.findSent({ accessToken, messageId }),
    "never",
  );
  assert.deepEqual(found, { ok: false, reason: "token_revoked" });
  const ids = [refreshed.id, read.id];
  for (const id of ids) {
    const row = await rowOf(id);
    assert.deepEqual(
      [row.status, row.disconnectedReason, row.oauthTokenRef],
      ["disconnected", "token_revoked", null],
    );
  }
  const entries = await app.outboxEntry.findMany({ where: { eventName: DISCONNECTED } });
  const payloads = entries.map((entry) => entry.payload as { mailbox_id: string; reason: string });
  assert.deepEqual(
    payloads.sort((a, b) => a.mailbox_id.localeCompare(b.mailbox_id)),
    [...ids].sort().map((id) => ({ mailbox_id: id, reason: "token_revoked" })),
  );
  const outbox = startOutboxLoop(app, log);
  try {
    for (const entry of entries) {
      await until(async () => {
        return (await app.outboxEntry.findUniqueOrThrow({ where: { id: entry.id } })).deliveredAt;
      });
    }
  } finally {
    await outbox.stop();
  }
  for (const id of ids) {
    const { disconnectedAt } = await rowOf(id);
    const runId = `email.revoke:${workspaceId}:${id}:${disconnectedAt?.toISOString()}`;
    await assert.rejects(env.client.workflow.getHandle(runId).describe(), "no revoke run");
  }
  assert.equal(callsOf("revokeAccess").length, 0);
  assert.deepEqual(await withMailboxTokens(context, read.id, ran), {
    ok: false,
    reason: "no_tokens",
  });
});
