// The safety cases of the kill switches (beta-p1-040; docs/security.md "Kill switches"), run by
// `pnpm -F @whytide/linkedin test:safety` and not by `test`: the account's, the workspace's and the
// platform's stop each refuse the next send and the next read with its code, and lifted let both
// reserve again; no platform row is sending closed, for sends only; the invites' pause holds invites
// only; the refusals' order; a send reserved before a stop is refused by the state check the send
// activity asks before the port call; remainingToday places nothing while a send would be refused; a
// tester cannot lift the operator's stop, nor the operator a tester's; and each change writes one
// control event, a call that changes nothing none, two at once one, which app can neither change
// nor delete.
import assert from "node:assert/strict";
import test from "node:test";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { isAppError } from "@whytide/platform";
import { findAccount } from "../../domain/accounts.ts";
import {
  pauseAccount,
  pauseAccountAsOperator,
  setPlatformSwitch,
  setWorkspaceStop,
  setWorkspaceStopAsOperator,
  unpauseAccount,
  unpauseAccountAsOperator,
} from "../../domain/controls/controls.ts";
import { remainingToday } from "../../domain/quota/reservations.ts";
import { sendStateRefusal } from "../../domain/send/state.ts";
import {
  setPlatformControls,
  useClock,
  useLinkedinClient,
  useRandom,
} from "../../testing/index.ts";
import { granted, sender, THURSDAY } from "../fixtures/send.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
useClock(() => THURSDAY);
useRandom(() => 0.999); // the day's limits are the targets: 5 connection requests, 10 messages
// remainingToday while sending is closed or a stop holds: nothing to place, no window, so that the
// daily plan places nothing for the account (decisions.md Finding 56).
const NOTHING = { invites: 0, messages: 0, withdrawals: 0, actions: 0, windowEnd: null };
const OPERATOR = "ops-anna";

type Sender = Awaited<ReturnType<typeof sender>>;

/** The account's owner, as createConnectedAccount made it. */
async function ownerOf(account: Sender): Promise<string> {
  return (await app.senderAccount.findUniqueOrThrow({ where: { id: account.id } })).ownerUserId;
}

/** The control events, oldest first: scope, target, account, control, states, actor, time. */
async function events() {
  const rows = await app.linkedinControlEvent.findMany({ orderBy: [{ at: "asc" }, { id: "asc" }] });
  return rows.map((row) => [
    row.scope,
    row.targetWorkspaceId,
    row.senderAccountId,
    row.control,
    `${row.fromState}>${row.toState}`,
    `${row.actorType}:${row.actor}`,
    row.at.toISOString(),
  ]);
}

/** The refusal of a send of each type and of a read, each `[code, retryAt]`. */
async function refusals(account: Sender, key: string) {
  const answers = [
    await account.send(`${key}-invite`, "invite"),
    await account.send(`${key}-message`, "message"),
    await account.send(`${key}-withdraw`, "withdraw"),
    await account.read(),
  ];
  return answers.map((answer) =>
    "refused" in answer ? [answer.refused, answer.retryAt] : ["granted", null],
  );
}

const failsWith = (expected: string) => (error: unknown) =>
  isAppError(error) && error.code === expected;

test("each kill switch, the account's, the workspace's and the platform's, refuses the next send of every type and the next read with its code and no time, each logged, and remainingToday answers nothing; lifted, both reserve again", async () => {
  const account = await sender();
  const owner = await ownerOf(account);
  granted(await account.send("before"));
  granted(await account.read());
  const stops = [
    {
      code: "account_stopped",
      stop: () => account.run(() => pauseAccount(account.id, owner)),
      lift: () => account.run(() => unpauseAccount(account.id, owner)),
    },
    {
      code: "workspace_stopped",
      stop: () => account.run(() => setWorkspaceStop(true, owner)),
      lift: () => account.run(() => setWorkspaceStop(false, owner)),
    },
    {
      code: "platform_stopped",
      stop: () => setPlatformSwitch("stop", true, OPERATOR),
      lift: () => setPlatformSwitch("stop", false, OPERATOR),
    },
  ];
  for (const { code, stop, lift } of stops) {
    await stop();
    const refused = [code, null];
    assert.deepEqual(await refusals(account, code), [refused, refused, refused, refused], code);
    assert.deepEqual(await account.run(() => remainingToday(account.id)), NOTHING, code);
    await lift();
    granted(await account.send(`${code}-lifted`, "message"));
    granted(await account.read());
  }
  const logged = await app.senderActionLog.findMany({
    where: { senderAccountId: account.id, outcome: { in: stops.map((stop) => stop.code) } },
  });
  assert.equal(logged.length, 12, "one log row for each refusal");
});

test("a database with no platform row refuses every send sending_closed with no time while a read reserves, and remainingToday answers nothing; once the operator opens sending, the send reserves", async () => {
  const account = await sender();
  await asRole("owner").linkedinPlatformControl.deleteMany({});
  const closed = ["sending_closed", null];
  assert.deepEqual(await refusals(account, "closed"), [closed, closed, closed, ["granted", null]]);
  assert.deepEqual(await account.run(() => remainingToday(account.id)), NOTHING);
  assert.equal(await setPlatformSwitch("sending", true, OPERATOR), "changed");
  granted(await account.send("opened"));
  assert.equal(await setPlatformSwitch("sending", false, OPERATOR), "changed");
  assert.deepEqual(await refusals(account, "closed-again"), [
    closed,
    closed,
    closed,
    ["granted", null],
  ]);
});

test("with sending open, the invites' pause refuses an invite invites_paused with no time and lets a message, a withdrawal and a read through; remainingToday answers no invite, the messages and the actions left", async () => {
  const account = await sender();
  await setPlatformControls({ invitesPaused: true });
  assert.deepEqual(await refusals(account, "paused"), [
    ["invites_paused", null],
    ["granted", null],
    ["granted", null],
    ["granted", null],
  ]);
  const left = await account.run(() => remainingToday(account.id));
  // A message, a withdrawal and a read reserved: 3 of the 200.
  const { invites, messages, withdrawals, actions } = left;
  assert.deepEqual([invites, messages, withdrawals, actions], [0, 9, 14, 197]);
  assert.notEqual(left.windowEnd, null);
});

test("the order: sending closed before every stop; the platform's stop before the workspace's before the account's; the stops before the account's status; the status before the invites' pause", async () => {
  const account = await sender();
  const owner = await ownerOf(account);
  await account.run(() => pauseAccount(account.id, owner));
  await account.run(() => setWorkspaceStop(true, owner));
  await setPlatformControls({ sendingOpen: false, stopped: true, invitesPaused: true });
  await app.senderAccount.update({ where: { id: account.id }, data: { status: "disconnected" } });
  const first = async () => {
    const [invite, , , read] = await refusals(account, "order");
    return [invite?.[0], read?.[0]];
  };
  assert.deepEqual(await first(), ["sending_closed", "platform_stopped"]);
  await setPlatformControls({ sendingOpen: true });
  assert.deepEqual(await first(), ["platform_stopped", "platform_stopped"]);
  await setPlatformControls({ stopped: false });
  assert.deepEqual(await first(), ["workspace_stopped", "workspace_stopped"]);
  await account.run(() => setWorkspaceStop(false, owner));
  assert.deepEqual(await first(), ["account_stopped", "account_stopped"]);
  await account.run(() => unpauseAccount(account.id, owner));
  assert.deepEqual(await first(), [
    "linkedin_account_disconnected",
    "linkedin_account_disconnected",
  ]);
  await app.senderAccount.update({ where: { id: account.id }, data: { status: "connected" } });
  assert.deepEqual(await first(), ["invites_paused", "granted"]);
});

test("a send reserved before a stop: a repeat of its key answers its hold, and sendStateRefusal, which the send activity asks again just before the port call, refuses it account_stopped", async () => {
  const account = await sender();
  const owner = await ownerOf(account);
  const held = granted(await account.send("held", "message"));
  await account.run(() => pauseAccount(account.id, owner));
  assert.deepEqual(await account.send("held", "message"), {
    reservationId: held,
    status: "reserved",
  });
  const check = await account.run(async () =>
    sendStateRefusal(await findAccount(account.id), "message", THURSDAY),
  );
  assert.deepEqual(check, { refused: "account_stopped", retryAt: null });
});

test("a tester cannot lift the operator's stop: unpause and the workspace's stop off answer stopped_by_operator and change nothing; the operator's pause takes a tester's over; the operator's unpause leaves a tester's pause, paused_by_tester; only the owner unpauses, not_account_owner", async () => {
  const account = await sender();
  const { workspaceId } = account;
  const owner = await ownerOf(account);
  const state = async () => {
    const row = await findAccountRow(account.id);
    const stop = await app.linkedinWorkspaceControl.findFirst({ where: { workspaceId } });
    return [row.killSwitch, row.killSwitchSource, stop?.stopped ?? false, stop?.stopSource ?? null];
  };

  assert.equal(await pauseAccountAsOperator(workspaceId, account.id, OPERATOR), "changed");
  assert.equal(await setWorkspaceStopAsOperator(workspaceId, true, OPERATOR), "changed");
  const before = await events();
  await assert.rejects(
    account.run(() => unpauseAccount(account.id, owner)),
    failsWith("stopped_by_operator"),
  );
  await assert.rejects(
    account.run(() => setWorkspaceStop(false, owner)),
    failsWith("stopped_by_operator"),
  );
  await account.run(() => pauseAccount(account.id, owner));
  await account.run(() => setWorkspaceStop(true, owner));
  assert.deepEqual(await state(), [true, "operator", true, "operator"]);
  assert.deepEqual(await events(), before, "no event for what changed nothing");
  refused(await account.read(), "workspace_stopped");

  assert.equal(await unpauseAccountAsOperator(workspaceId, account.id, OPERATOR), "changed");
  assert.equal(await setWorkspaceStopAsOperator(workspaceId, false, OPERATOR), "changed");
  await account.run(() => pauseAccount(account.id, owner));
  await account.run(() => setWorkspaceStop(true, owner));
  assert.equal(
    await unpauseAccountAsOperator(workspaceId, account.id, OPERATOR),
    "paused_by_tester",
  );
  assert.equal(await setWorkspaceStopAsOperator(workspaceId, false, OPERATOR), "paused_by_tester");
  assert.deepEqual(await state(), [true, "tester", true, "tester"]);
  assert.equal(await pauseAccountAsOperator(workspaceId, account.id, OPERATOR), "changed");
  assert.deepEqual((await state()).slice(0, 2), [true, "operator"]);

  const other = await sender();
  await other.run(() => pauseAccount(other.id, "usr_someone_else"));
  await assert.rejects(
    other.run(() => unpauseAccount(other.id, "usr_someone_else")),
    failsWith("not_account_owner"),
  );
  assert.equal((await findAccountRow(other.id)).killSwitch, true);
});

test("each change writes one control event with its scope, target, states, actor and time, in the same run; a call that changes nothing writes none; two presses at once change once; app can neither update nor delete an event, nor delete the platform row (42501)", async () => {
  const account = await sender();
  const { workspaceId } = account;
  const owner = await ownerOf(account);
  const at = THURSDAY.toISOString();
  const pause = () => account.run(() => pauseAccount(account.id, owner));
  const unpause = () => account.run(() => unpauseAccount(account.id, owner));
  const stop = (on: boolean) => account.run(() => setWorkspaceStop(on, "usr_member"));

  await Promise.all([pause(), pause()]);
  await pause();
  await Promise.all([unpause(), unpause()]);
  await Promise.all([stop(true), stop(true)]);
  await stop(true);
  await stop(false);
  await stop(false);
  assert.equal(await setPlatformSwitch("sending", true, OPERATOR), "unchanged"); // the fixture's
  assert.equal(await setPlatformSwitch("stop", true, OPERATOR), "changed");
  assert.equal(await setPlatformSwitch("stop", true, OPERATOR), "unchanged");
  await assert.rejects(
    account.run(async () => {
      await pauseAccount(account.id, owner);
      throw new Error("the run rolls back");
    }),
  );
  assert.deepEqual(await events(), [
    ["account", workspaceId, account.id, "stop", "off>tester", `user:${owner}`, at],
    ["account", workspaceId, account.id, "stop", "tester>off", `user:${owner}`, at],
    ["workspace", workspaceId, null, "stop", "off>tester", "user:usr_member", at],
    ["workspace", workspaceId, null, "stop", "tester>off", "user:usr_member", at],
    ["platform", null, null, "stop", "off>on", `operator:${OPERATOR}`, at],
  ]);
  assert.equal((await findAccountRow(account.id)).killSwitch, false, "rolled back with its run");

  const update = app.$executeRaw`UPDATE linkedin_control_events SET actor = 'someone'`;
  assert.equal(await sqlstate(update), "42501", "app must not update a control event");
  const remove = app.$executeRaw`DELETE FROM linkedin_control_events`;
  assert.equal(await sqlstate(remove), "42501", "app must not delete a control event");
  const lift = app.$executeRaw`DELETE FROM linkedin_platform_controls`;
  assert.equal(await sqlstate(lift), "42501", "app must not delete the platform's row");
  assert.equal(await app.linkedinControlEvent.count(), 5);
});

test("the database holds a stop's source to the stop: on without a source, or a source while off, is refused (23514); a second platform row too", async () => {
  const account = await sender();
  const CHECK = "23514";
  const noSource = app.senderAccount.update({
    where: { id: account.id },
    data: { killSwitch: true },
  });
  assert.equal(await sqlstate(noSource), CHECK);
  const sourceOff = app.senderAccount.update({
    where: { id: account.id },
    data: { killSwitchSource: "tester" },
  });
  assert.equal(await sqlstate(sourceOff), CHECK);
  const workspace = app.$executeRaw`INSERT INTO linkedin_workspace_controls (id, workspace_id, stopped, changed_at) VALUES ('lwc_check', ${account.workspaceId}, true, now())`;
  assert.equal(await sqlstate(workspace), CHECK);
  const second = app.$executeRaw`INSERT INTO linkedin_platform_controls (id, singleton, changed_at) VALUES ('lpc_second', true, now())`;
  assert.equal(await sqlstate(second), "23505");
  const notSingleton = app.$executeRaw`INSERT INTO linkedin_platform_controls (id, singleton, changed_at) VALUES ('lpc_false', false, now())`;
  assert.equal(await sqlstate(notSingleton), CHECK);
});

function findAccountRow(id: string) {
  return app.senderAccount.findUniqueOrThrow({ where: { id } });
}

function refused(answer: { refused: string } | { reservationId: string }, expected: string) {
  assert.ok("refused" in answer && answer.refused === expected, JSON.stringify(answer));
}
