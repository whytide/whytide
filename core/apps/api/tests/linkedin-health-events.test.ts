// linkedin's account health through its webhook, end to end (beta-p6-010; core/modules/linkedin/
// README.md "Health"): the host started with identity and linkedin on the fakes, in a schema of the
// worktree's database, answering POST /v1/linkedin/webhooks/fake on the fake's signed events: a
// restricted and a checkpoint status, a lost session (credentials_required, account.disconnected) and
// its reconnect, and the C26 sequence, each with the account's health, its health events, the
// outbox's linkedin.account_paused, and the next send's and read's refusal; the fleet breaker a
// restriction trips (beta-p6-030), with linkedin.invites_paused once. No worker runs: the owner's
// and the operator's mails wait in the outbox. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import {
  collectLogs,
  createLogger,
  loadMasterKeys,
  newMasterKey,
  servicePrincipal,
} from "@whytide/platform";
import {
  getAdapter,
  type LinkedinFake,
  type LinkedinWebhook,
  linkedinPort,
} from "@whytide/providers";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import type { Api, StartOptions } from "../src/start.ts";

process.env.APP_PUBLIC_ORIGIN = "https://app.whytide.test";
const { start } = await import("../src/start.ts");
// linkedin by its build's path, as src/modules.generated.ts loads it (linkedin-webhooks.test.ts).
const build = new URL("../../../../modules/linkedin/dist/", import.meta.url);
type Linkedin = typeof import("../../../modules/linkedin/dist/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
const linkedin: Linkedin = await import(new URL("index.js", build).href);
const testing: LinkedinTesting = await import(new URL("testing/index.js", build).href);
const { createConnectedAccount, openSending, useClock, useLinkedinClient, useSecretKeys } = testing;

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
useLinkedinClient(app);
useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
/** Thursday 22 October 2026, 10:00 UTC: linkedin's clock, the health changes' time. */
const NOW = new Date("2026-10-22T10:00:00Z");
const COOLDOWN_END = new Date(NOW.getTime() + 72 * 3_600_000);
useClock(() => NOW);
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const principal = servicePrincipal("linkedin_test");
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  const options: StartOptions = {
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "linkedin", load: () => import(new URL("index.js", build).href) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  };
  api = await start(options);
});
after(() => api?.close());

/** The vendor's call: no cookie, no workspace; the status the host answered. */
async function post({ headers, rawBody }: LinkedinWebhook): Promise<number> {
  const url = new URL("/v1/linkedin/webhooks/fake", api.url);
  const init = { method: "POST", headers: headers as Record<string, string>, body: rawBody };
  const res = await fetch(url, init);
  await res.text();
  return res.status;
}

/** A connected account of a new workspace, by its reference, with sending open. */
async function seeded() {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const ref = `fake-account-${randomUUID()}`;
  const { id: accountId } = await createConnectedAccount(workspaceId, { providerAccountRef: ref });
  await openSending();
  const run = <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app });
  const refusals = async () => {
    const send = { accountId, actionType: "message", idempotencyKey: randomUUID() } as const;
    const read = { accountId, count: 1, kind: "read_profile" } as const;
    const answers = [
      await run(() => linkedin.reserveSend(send)),
      await run(() => linkedin.reserveReads(read)),
    ];
    return answers.map((answer) => ("refused" in answer ? answer.refused : "granted"));
  };
  /** The next connection request's and message's answers, each its refusal or `granted`. */
  const sends = async () => {
    const answers = [];
    for (const actionType of ["invite", "message"] as const) {
      const send = { accountId, actionType, idempotencyKey: randomUUID() };
      answers.push(await run(() => linkedin.reserveSend(send)));
    }
    return answers.map((answer) => ("refused" in answer ? answer.refused : "granted"));
  };
  return { workspaceId, ref, accountId, refusals, sends };
}

/** The account's status, health and cool-down, its health events and the outbox's pause events. */
async function healthOf(workspaceId: string, accountId: string) {
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id: accountId } });
  const events = await app.senderHealthEvent.findMany({
    where: { senderId: accountId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const paused = await app.outboxEntry.findMany({
    where: { workspaceId, eventName: "linkedin.account_paused" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return {
    status: row.status,
    state: row.healthState,
    pausedUntil: row.pausedUntil,
    events: events.map((event) => [`${event.fromState}>${event.toState}`, event.trigger]),
    announced: paused.map((entry) => entry.payload),
    eventIds: events.map((event) => event.id),
  };
}

test("a restricted and a checkpoint status each answer 204 and pause the account in the webhook's run: the state, the cool-down 72 hours on, one health event with its trigger, linkedin.account_paused with its id; the next send and read are refused account_paused", async () => {
  for (const [status, trigger] of [
    ["restricted", "limit_reached"],
    ["checkpoint", "checkpoint"],
  ] as const) {
    const { workspaceId, ref, accountId, refusals } = await seeded();
    assert.equal(await post(fake.emitAccountStatus(ref, status)), 204);
    const health = await healthOf(workspaceId, accountId);
    assert.deepEqual(
      [health.status, health.state, health.pausedUntil, health.events],
      ["connected", status, COOLDOWN_END, [[`healthy>${status}`, trigger]]],
    );
    const [eventId] = health.eventIds;
    assert.deepEqual(health.announced, [
      { sender_account_id: accountId, health_event_id: eventId },
    ]);
    assert.deepEqual(await refusals(), ["account_paused", "account_paused"]);
  }
});

test("a lost session, credentials_required or account.disconnected, sets disconnected (session_invalid) with linkedin.account_paused and refuses as disconnected; the connect returns it to healthy (manual) with no pause event, and both reserve again", async () => {
  for (const lost of ["account.credentials_required", "account.disconnected"] as const) {
    const { workspaceId, ref, accountId, refusals } = await seeded();
    assert.equal(await post(fake.emitWebhook(lost, ref)), 204);
    const gone = await healthOf(workspaceId, accountId);
    assert.deepEqual(
      [gone.state, gone.events],
      ["disconnected", [["healthy>disconnected", "session_invalid"]]],
      lost,
    );
    assert.equal(gone.announced.length, 1, lost);
    const refused = "linkedin_account_disconnected";
    assert.deepEqual(await refusals(), [refused, refused], lost);
    assert.equal(await post(fake.emitWebhook("account.connected", ref)), 204);
    const back = await healthOf(workspaceId, accountId);
    assert.deepEqual(
      [back.status, back.state, back.events, back.announced.length],
      [
        "connected",
        "healthy",
        [
          ["healthy>disconnected", "session_invalid"],
          ["disconnected>healthy", "manual"],
        ],
        1,
      ],
      lost,
    );
    assert.deepEqual(await refusals(), ["granted", "granted"], lost);
  }
});

test("C26 through the route: restricted, then account.disconnected and account.connected, leave the account restricted with the same cool-down and one event; the session is back, the sends and reads stay refused account_paused", async () => {
  const { workspaceId, ref, accountId, refusals } = await seeded();
  assert.equal(await post(fake.emitAccountStatus(ref, "restricted")), 204);
  assert.equal(await post(fake.emitWebhook("account.disconnected", ref)), 204);
  assert.equal(await post(fake.emitWebhook("account.connected", ref)), 204);
  const health = await healthOf(workspaceId, accountId);
  assert.deepEqual(
    [health.status, health.state, health.pausedUntil, health.events, health.announced.length],
    ["connected", "restricted", COOLDOWN_END, [["healthy>restricted", "limit_reached"]], 1],
  );
  assert.deepEqual(await refusals(), ["account_paused", "account_paused"]);
});

test("a restricted status trips the fleet breaker in the webhook's run: the instance's invites paused by the system with the trigger, one control event naming the account and its workspace, linkedin.invites_paused once with the warning's event; a second account's checkpoint trips nothing more; another workspace's account is refused its invites and still messages", async () => {
  const [first, second, other] = [await seeded(), await seeded(), await seeded()];
  assert.deepEqual(await other.sends(), ["granted", "granted"]);
  assert.equal(await post(fake.emitAccountStatus(first.ref, "restricted")), 204);
  assert.equal(await post(fake.emitAccountStatus(second.ref, "checkpoint")), 204);

  const row = await app.linkedinPlatformControl.findFirstOrThrow({
    select: { invitesPaused: true, invitesPausedReason: true, changedBy: true },
  });
  assert.deepEqual(row, {
    invitesPaused: true,
    invitesPausedReason: "limit_reached",
    changedBy: "system",
  });
  const events = await app.linkedinControlEvent.findMany({ where: { control: "invites" } });
  assert.deepEqual(
    events.map((event) => [
      event.scope,
      event.targetWorkspaceId,
      event.senderAccountId,
      `${event.fromState}>${event.toState}`,
      `${event.actorType}:${event.actor}`,
      event.reason,
    ]),
    [
      [
        "platform",
        first.workspaceId,
        first.accountId,
        "off>on",
        "system:fleet_breaker",
        "limit_reached",
      ],
    ],
  );
  const [warning] = (await healthOf(first.workspaceId, first.accountId)).eventIds;
  const announced = await app.outboxEntry.findMany({
    where: { eventName: "linkedin.invites_paused" },
  });
  assert.deepEqual(
    announced.map((entry) => [entry.workspaceId, entry.payload]),
    [[first.workspaceId, { sender_account_id: first.accountId, health_event_id: warning }]],
  );
  assert.deepEqual(await other.sends(), ["invites_paused", "granted"]);
});
