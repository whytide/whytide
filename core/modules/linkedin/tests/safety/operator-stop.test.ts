// The safety cases of the operator's command (beta-p1-060; docs/security.md "The control command"),
// run by `pnpm -F @whytide/linkedin test:safety` and not by `test`: after `stop --platform` the next
// send and the next read in every workspace are refused platform_stopped, and after `start
// --platform` both reserve again; `sending close` refuses sends only; the operator's pause of a
// workspace or an account stops that workspace or that account only; the tester's commands of
// domain/controls/, which the routes call, cannot lift the operator's pause or stop; and a change
// and its control event commit together, the platform's too.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { createOrganizationWithWorkspace, useTenancyClient } from "@whytide/tenancy/testing";
import { runControl } from "../../cli/control.ts";
import { pauseAccount, setWorkspaceStop, unpauseAccount } from "../../domain/controls/controls.ts";
import { reserveReads } from "../../domain/quota/reservations.ts";
import { reserveSend } from "../../domain/send/reserve.ts";
import {
  createConnectedAccount,
  openSending,
  useClock,
  useLinkedinClient,
  useRandom,
} from "../../testing/index.ts";
import { ALWAYS, THURSDAY } from "../fixtures/send.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
useTenancyClient(app);
useClock(() => THURSDAY);
useRandom(() => 0.999); // the day's limits are the targets: 10 messages
const principal = servicePrincipal("linkedin_test");
const BY = "--operator ops-anna";
const GRANTED = ["granted", "granted"];

type Account = Awaited<ReturnType<typeof workspace>>["accounts"][number];

/** The command's exit code and lines, its arguments split at spaces. */
async function control(args: string) {
  const lines: string[] = [];
  const code = await runControl(args.split(" "), (line) => {
    lines.push(line);
  });
  return { code, lines };
}

/** A workspace of tenancy's, so that --workspace finds it, with two connected accounts. */
async function workspace() {
  const made = (await createOrganizationWithWorkspace()).workspace;
  const run = <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId: made.id, principal }, fn, { client: app, timeout: 30_000 });
  const account = async (owner: string) => {
    const settings = { ownerUserId: owner, workingHours: ALWAYS };
    const { id } = await createConnectedAccount(made.id, settings);
    let sends = 0;
    const key = () => `${id}-${++sends}`;
    return {
      id,
      owner,
      run,
      send: () =>
        run(() => reserveSend({ accountId: id, actionType: "message", idempotencyKey: key() })),
      read: () => run(() => reserveReads({ accountId: id, count: 1, kind: "send_check" })),
    };
  };
  const accounts = [
    await account(`usr_a${made.id.slice(4)}`),
    await account(`usr_b${made.id.slice(4)}`),
  ] as const;
  return { id: made.id, slug: made.slug, run, accounts };
}

/** Each account's next send and next read: the code it is refused with, or `granted`. */
async function answers(accounts: readonly Account[]) {
  const code = (answer: object) => ("refused" in answer ? String(answer.refused) : "granted");
  const out: string[][] = [];
  for (const account of accounts)
    out.push([code(await account.send()), code(await account.read())]);
  return out;
}

/** The switches as the tables hold them, and the control events' count. */
async function switches() {
  const platform = await app.linkedinPlatformControl.findMany({
    select: { sendingOpen: true, stopped: true },
  });
  const stops = await app.linkedinWorkspaceControl.findMany({
    select: { workspaceId: true, stopped: true, stopSource: true },
    orderBy: { workspaceId: "asc" },
  });
  const paused = await app.senderAccount.findMany({
    select: { id: true, killSwitch: true, killSwitchSource: true },
    orderBy: { id: "asc" },
  });
  return { platform, stops, paused, events: await app.linkedinControlEvent.count() };
}

const failsWith = (expected: string) => (error: unknown) =>
  isAppError(error) && error.code === expected;

test("after stop --platform the next send and the next read in every workspace are refused platform_stopped; after start --platform both reserve again", async () => {
  const all = [...(await workspace()).accounts, ...(await workspace()).accounts];
  await openSending();
  assert.deepEqual(
    await answers(all),
    all.map(() => GRANTED),
  );

  assert.deepEqual(await control(`stop --platform ${BY}`), {
    code: 0,
    lines: ["changed: platform stopped"],
  });
  const stopped = ["platform_stopped", "platform_stopped"];
  assert.deepEqual(
    await answers(all),
    all.map(() => stopped),
  );

  assert.deepEqual(await control(`start --platform ${BY}`), {
    code: 0,
    lines: ["changed: platform started"],
  });
  assert.deepEqual(
    await answers(all),
    all.map(() => GRANTED),
  );
});

test("after sending close the next send is refused sending_closed while the next read reserves, in every workspace", async () => {
  const all = [...(await workspace()).accounts, ...(await workspace()).accounts];
  await openSending();
  assert.deepEqual(
    await answers(all),
    all.map(() => GRANTED),
  );
  assert.deepEqual(await control(`sending close ${BY}`), {
    code: 0,
    lines: ["changed: sending closed"],
  });
  assert.deepEqual(
    await answers(all),
    all.map(() => ["sending_closed", "granted"]),
  );
});

test("pause --workspace refuses the next send and read in that workspace, by slug or id, and not in another; pause --account refuses that account's and not the other account's of its workspace; unpause lifts each", async () => {
  const [w, other] = [await workspace(), await workspace()];
  const [a, b] = w.accounts;
  await openSending();
  const everyone = [...w.accounts, ...other.accounts];
  const stopped = ["workspace_stopped", "workspace_stopped"];

  assert.equal((await control(`pause --workspace ${w.slug} ${BY}`)).code, 0);
  assert.deepEqual(await answers(everyone), [stopped, stopped, GRANTED, GRANTED]);
  assert.equal((await control(`unpause --workspace ${w.id} ${BY}`)).code, 0);
  assert.deepEqual(
    await answers(everyone),
    everyone.map(() => GRANTED),
  );

  assert.equal((await control(`pause --workspace ${w.id} --account ${a.id} ${BY}`)).code, 0);
  const paused = ["account_stopped", "account_stopped"];
  assert.deepEqual(await answers(everyone), [paused, GRANTED, GRANTED, GRANTED]);
  assert.equal((await control(`unpause --workspace ${w.slug} --account ${a.id} ${BY}`)).code, 0);
  assert.deepEqual(await answers([a, b]), [GRANTED, GRANTED]);
});

test("the tester's unpause and workspace stop of domain/controls/, which the routes call, cannot lift the operator's pause or stop: stopped_by_operator, nothing changed, no event; the tester's own pause keeps the operator's", async () => {
  const w = await workspace();
  const [a] = w.accounts;
  await openSending();
  assert.equal((await control(`pause --workspace ${w.id} --account ${a.id} ${BY}`)).code, 0);
  assert.equal((await control(`pause --workspace ${w.id} ${BY}`)).code, 0);
  const before = await switches();

  await assert.rejects(
    w.run(() => unpauseAccount(a.id, a.owner)),
    failsWith("stopped_by_operator"),
  );
  await assert.rejects(
    w.run(() => setWorkspaceStop(false, a.owner)),
    failsWith("stopped_by_operator"),
  );
  await w.run(() => pauseAccount(a.id, a.owner));
  await w.run(() => setWorkspaceStop(true, a.owner));
  assert.deepEqual(await switches(), before);
  const held = before.paused.find((row) => row.id === a.id);
  assert.deepEqual([held?.killSwitch, held?.killSwitchSource], [true, "operator"]);
  assert.deepEqual(
    before.stops.map((row) => [row.workspaceId, row.stopped, row.stopSource]),
    [[w.id, true, "operator"]],
  );
  assert.deepEqual(await answers([a]), [["workspace_stopped", "workspace_stopped"]]);
});

test("a change and its control event commit together: with the event's insert refused, stop --platform, sending open and a workspace's pause fail and change nothing", async () => {
  const w = await workspace();
  const owner = asRole("owner");
  const before = await switches();
  await owner.$executeRawUnsafe("REVOKE INSERT ON TABLE linkedin_control_events FROM app");
  try {
    await assert.rejects(control(`stop --platform ${BY}`));
    await assert.rejects(control(`sending open ${BY}`));
    await assert.rejects(control(`pause --workspace ${w.id} ${BY}`));
  } finally {
    await owner.$executeRawUnsafe("GRANT INSERT ON TABLE linkedin_control_events TO app");
  }
  assert.deepEqual(await switches(), before);
  assert.deepEqual(before.platform, [], "no platform row was made");
  assert.equal((await control(`stop --platform ${BY}`)).code, 0, "the grant is back");
});
