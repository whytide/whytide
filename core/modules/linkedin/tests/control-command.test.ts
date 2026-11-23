// `pnpm linkedin:control` (README.md "The control command"), run as its bin runs it, on this file's
// schema, as identity's tests/tenant-commands.test.ts runs its commands: each subcommand, the switch
// it sets and the control event naming the operator, `unchanged` for a change that changes nothing,
// the refusals and the usage errors with their exit codes, which change nothing, `status`'s lines;
// and the built dist/cli/control.js run by node alone. The reservations' side is
// tests/safety/operator-stop.test.ts, and the fleet breaker's tests/safety/fleet-breaker.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { createOrganizationWithWorkspace, useTenancyClient } from "@whytide/tenancy/testing";
import { USAGE } from "../cli/constants.ts";
import { runControl } from "../cli/control.ts";
import { pauseAccount, setWorkspaceStop } from "../domain/controls/controls.ts";
import { tripBreaker } from "../domain/health/breaker.ts";
import { pauseRemovedMember } from "../domain/removed.ts";
import { createConnectedAccount, useLinkedinClient } from "../testing/index.ts";
import { member } from "./fixtures/send.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
useTenancyClient(app);
const OPERATOR = "ops-anna";
const BY = ["--operator", OPERATOR];
const MODULE = join(import.meta.dirname, "..");
const principal = servicePrincipal("linkedin_test");

/** The command's exit code and lines; an argument string splits at spaces. */
async function control(args: string | readonly string[]) {
  const lines: string[] = [];
  const code = await runControl(typeof args === "string" ? args.split(" ") : [...args], (line) => {
    lines.push(line);
  });
  return { code, lines };
}

/** A workspace of tenancy's, so that --workspace finds it by its id or its slug. */
const tenant = async () => (await createOrganizationWithWorkspace()).workspace;

/** The tester's press in the workspace, through domain/controls/ as the routes call it. */
const asTester = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app });

/** The control events, oldest first: scope, workspace, account, control, states, actor. */
async function events() {
  const rows = await app.linkedinControlEvent.findMany({ orderBy: { id: "asc" } });
  return rows.map((row) => [
    row.scope,
    row.targetWorkspaceId,
    row.senderAccountId,
    row.control,
    `${row.fromState}>${row.toState}`,
    `${row.actorType}:${row.actor}`,
  ]);
}

/** The platform's row as the command leaves it, or null. */
const platformRow = () =>
  app.linkedinPlatformControl.findFirst({
    select: { sendingOpen: true, stopped: true, invitesPaused: true, changedBy: true },
  });

/** The fleet breaker tripped by a warning on the account, in its workspace's run. */
const trip = (workspaceId: string, accountId: string) =>
  withTenant(
    { workspaceId, principal },
    (tx) => tripBreaker(tx, accountId, { id: "she_warning", trigger: "checkpoint" }),
    { client: app },
  );

/** Every switch as the tables hold it, with the events: what a refusal or a usage error leaves. */
async function everything() {
  return {
    platform: await app.linkedinPlatformControl.findMany(),
    workspaces: await app.linkedinWorkspaceControl.findMany({ orderBy: { workspaceId: "asc" } }),
    accounts: await app.senderAccount.findMany({
      select: { id: true, killSwitch: true, killSwitchSource: true },
      orderBy: { id: "asc" },
    }),
    events: await events(),
  };
}

test("sending open on a fresh database makes the platform row and opens sending, one event naming the operator; sending close closes it with its event; a repeat prints unchanged, exits 0 and appends no event", async () => {
  assert.deepEqual(await control(["sending", "close", ...BY]), {
    code: 0,
    lines: ["unchanged: sending closed"],
  });
  assert.equal(await platformRow(), null, "closing makes no row");

  assert.deepEqual(await control(["sending", "open", ...BY]), {
    code: 0,
    lines: ["changed: sending open"],
  });
  const open = { sendingOpen: true, stopped: false, invitesPaused: false, changedBy: OPERATOR };
  assert.deepEqual(await platformRow(), open);
  assert.deepEqual(await control(["sending", "open", ...BY]), {
    code: 0,
    lines: ["unchanged: sending open"],
  });
  assert.deepEqual(await control("sending close --operator ops.ben_2"), {
    code: 0,
    lines: ["changed: sending closed"],
  });
  assert.deepEqual(await control("sending close --operator ops.ben_2"), {
    code: 0,
    lines: ["unchanged: sending closed"],
  });
  assert.deepEqual(await platformRow(), { ...open, sendingOpen: false, changedBy: "ops.ben_2" });
  assert.deepEqual(await events(), [
    ["platform", null, null, "sending", "closed>open", `operator:${OPERATOR}`],
    ["platform", null, null, "sending", "open>closed", "operator:ops.ben_2"],
  ]);
});

test("stop --platform and start --platform set the platform's stop, one event each naming the operator, sending left as it was; a repeat prints unchanged and appends none", async () => {
  assert.deepEqual(await control(["stop", "--platform", ...BY]), {
    code: 0,
    lines: ["changed: platform stopped"],
  });
  assert.deepEqual(await control(["stop", "--platform", ...BY]), {
    code: 0,
    lines: ["unchanged: platform stopped"],
  });
  const stopped = { sendingOpen: false, stopped: true, invitesPaused: false, changedBy: OPERATOR };
  assert.deepEqual(await platformRow(), stopped);
  assert.deepEqual(await control(["start", "--platform", ...BY]), {
    code: 0,
    lines: ["changed: platform started"],
  });
  assert.deepEqual(await control(["start", "--platform", ...BY]), {
    code: 0,
    lines: ["unchanged: platform started"],
  });
  assert.deepEqual(await platformRow(), { ...stopped, stopped: false });
  assert.deepEqual(await events(), [
    ["platform", null, null, "stop", "off>on", `operator:${OPERATOR}`],
    ["platform", null, null, "stop", "on>off", `operator:${OPERATOR}`],
  ]);
});

test("pause and unpause --workspace, by slug and by id: the workspace's stop, source operator, one event each; the operator's pause takes a tester's stop over; the operator's unpause of a tester's stop exits 1 paused_by_tester and changes nothing", async () => {
  const w = await tenant();
  const stopOf = () =>
    app.linkedinWorkspaceControl.findFirst({
      where: { workspaceId: w.id },
      select: { stopped: true, stopSource: true, changedBy: true },
    });

  assert.deepEqual(await control(["pause", "--workspace", w.slug, ...BY]), {
    code: 0,
    lines: [`changed: workspace ${w.id} paused`],
  });
  assert.deepEqual(await stopOf(), { stopped: true, stopSource: "operator", changedBy: OPERATOR });
  assert.deepEqual(await control(["pause", "--workspace", w.id, ...BY]), {
    code: 0,
    lines: [`unchanged: workspace ${w.id} paused`],
  });
  assert.deepEqual(await control(["unpause", "--workspace", w.id, ...BY]), {
    code: 0,
    lines: [`changed: workspace ${w.id} unpaused`],
  });
  assert.deepEqual(await control(["unpause", "--workspace", w.slug, ...BY]), {
    code: 0,
    lines: [`unchanged: workspace ${w.id} unpaused`],
  });

  await asTester(w.id, () => setWorkspaceStop(true, member("usr_tester", w.id)));
  const before = await everything();
  assert.deepEqual(await control(["unpause", "--workspace", w.slug, ...BY]), {
    code: 1,
    lines: [`paused_by_tester: workspace ${w.id}`],
  });
  assert.deepEqual(await everything(), before);
  assert.deepEqual(await control(["pause", "--workspace", w.slug, ...BY]), {
    code: 0,
    lines: [`changed: workspace ${w.id} paused`],
  });
  assert.deepEqual(await stopOf(), { stopped: true, stopSource: "operator", changedBy: OPERATOR });
  const workspace = (states: string, actor: string) => {
    return ["workspace", w.id, null, "stop", states, actor];
  };
  assert.deepEqual(await events(), [
    workspace("off>operator", `operator:${OPERATOR}`),
    workspace("operator>off", `operator:${OPERATOR}`),
    workspace("off>tester", "user:usr_tester"),
    workspace("tester>operator", `operator:${OPERATOR}`),
  ]);
});

test("pause and unpause --workspace --account: the account's switch, source operator, one event each; the operator's pause takes a tester's over; the operator's unpause of a tester's pause exits 1 paused_by_tester and changes nothing", async () => {
  const w = await tenant();
  const { id } = await createConnectedAccount(w.id, { ownerUserId: "usr_owner" });
  const switchOf = () =>
    app.senderAccount.findUniqueOrThrow({
      where: { id },
      select: { killSwitch: true, killSwitchSource: true },
    });
  const pause = ["pause", "--workspace", w.slug, "--account", id, ...BY];
  const unpause = ["unpause", "--workspace", w.id, "--account", id, ...BY];

  assert.deepEqual(await control(pause), { code: 0, lines: [`changed: account ${id} paused`] });
  assert.deepEqual(await switchOf(), { killSwitch: true, killSwitchSource: "operator" });
  assert.deepEqual(await control(pause), { code: 0, lines: [`unchanged: account ${id} paused`] });
  assert.deepEqual(await control(unpause), { code: 0, lines: [`changed: account ${id} unpaused`] });
  assert.deepEqual(await control(unpause), {
    code: 0,
    lines: [`unchanged: account ${id} unpaused`],
  });

  await asTester(w.id, () => pauseAccount(id, member("usr_owner", w.id)));
  const before = await everything();
  assert.deepEqual(await control(unpause), {
    code: 1,
    lines: [`paused_by_tester: account ${id}`],
  });
  assert.deepEqual(await everything(), before);
  assert.deepEqual(await control(pause), { code: 0, lines: [`changed: account ${id} paused`] });
  assert.deepEqual(await switchOf(), { killSwitch: true, killSwitchSource: "operator" });
  const account = (states: string, actor: string) => ["account", w.id, id, "stop", states, actor];
  assert.deepEqual(await events(), [
    account("off>operator", `operator:${OPERATOR}`),
    account("operator>off", `operator:${OPERATOR}`),
    account("off>tester", "user:usr_owner"),
    account("tester>operator", `operator:${OPERATOR}`),
  ]);
});

test("status prints the platform's switches, then each workspace's id, slug, stop and source, each followed by its accounts' id, owner, status, switch and source: ids and codes only; --workspace prints one workspace", async () => {
  const [w1, w2] = [await tenant(), await tenant()].sort((a, b) => a.id.localeCompare(b.id));
  assert.ok(w1 && w2);
  const one = await createConnectedAccount(w1.id, { ownerUserId: "usr_owner_one" });
  const two = await createConnectedAccount(w1.id, { ownerUserId: "usr_owner_two" });
  const tester = { label: "Ada Lovelace's LinkedIn", status: "credentials_required" as const };
  await app.senderAccount.update({ where: { id: two.id }, data: tester });
  assert.equal(
    (await control(["pause", "--workspace", w1.id, "--account", one.id, ...BY])).code,
    0,
  );
  await asTester(w2.id, () => setWorkspaceStop(true, member("usr_tester", w2.id)));
  assert.equal((await control(["stop", "--platform", ...BY])).code, 0);
  const before = await everything();

  const all = await control("status");
  assert.deepEqual(all, {
    code: 0,
    lines: [
      "platform: sending=closed stop=on invites_paused=off reason=none",
      `workspace: ${w1.id} slug=${w1.slug} stop=off source=none`,
      `account: ${one.id} workspace=${w1.id} owner=usr_owner_one status=connected switch=on source=operator`,
      `account: ${two.id} workspace=${w1.id} owner=usr_owner_two status=credentials_required switch=off source=none`,
      `workspace: ${w2.id} slug=${w2.slug} stop=on source=tester`,
    ],
  });
  for (const line of all.lines) {
    assert.match(line, /^[a-z]+:( [a-z]+_[0-9A-Z]+)?( [a-z_]+=[A-Za-z0-9_-]+)+$/, line);
    assert.doesNotMatch(line, /Ada|LinkedIn/, "the label is the user's: never printed");
  }
  assert.deepEqual(await control(["status", "--workspace", w2.slug]), {
    code: 0,
    lines: [all.lines[0], all.lines[4]],
  });
  assert.deepEqual(await everything(), before, "status changes nothing");
});

test("a removed member's pause (gamma-p6-070): status prints its source, member_removed; the operator's unpause leaves it, paused_by_member_removed, as a tester's, and the operator's pause takes it over", async () => {
  const w = await tenant();
  const { id } = await createConnectedAccount(w.id, { ownerUserId: "usr_removed" });
  assert.equal(await asTester(w.id, () => pauseRemovedMember("usr_removed")), 1);
  const status = await control(["status", "--workspace", w.id]);
  const line = `account: ${id} workspace=${w.id} owner=usr_removed status=connected switch=on source=member_removed`;
  assert.deepEqual([status.code, status.lines.includes(line)], [0, true], status.lines.join("\n"));
  const account = ["--workspace", w.id, "--account", id, ...BY];
  assert.deepEqual(await control(["unpause", ...account]), {
    code: 1,
    lines: [`paused_by_member_removed: account ${id}`],
  });
  assert.deepEqual(await control(["pause", ...account]), {
    code: 0,
    lines: [`changed: account ${id} paused`],
  });
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id } });
  assert.deepEqual([row.killSwitch, row.killSwitchSource], [true, "operator"]);
});

test("breaker reopen opens the connection requests the fleet breaker paused: not paused, unchanged and no row; paused, status prints the reason, the reopen clears it, the operator its changed_by, one event naming the operator; a repeat prints unchanged and appends none", async () => {
  const w = await tenant();
  const { id } = await createConnectedAccount(w.id);
  const reopen = ["breaker", "reopen", ...BY];
  assert.deepEqual(await control(reopen), { code: 0, lines: ["unchanged: invites open"] });
  assert.equal(await platformRow(), null, "a reopen makes no row");

  assert.equal(await trip(w.id, id), true);
  const paused = "platform: sending=closed stop=off invites_paused=on reason=checkpoint";
  assert.equal((await control("status")).lines[0], paused);
  assert.deepEqual(await control(reopen), { code: 0, lines: ["changed: invites open"] });
  const open = { sendingOpen: false, stopped: false, invitesPaused: false, changedBy: OPERATOR };
  assert.deepEqual(await platformRow(), open);
  assert.deepEqual(await control(reopen), { code: 0, lines: ["unchanged: invites open"] });
  const reason = await app.linkedinPlatformControl.findFirst({
    select: { invitesPausedReason: true },
  });
  assert.deepEqual(reason, { invitesPausedReason: null });
  const opened = "platform: sending=closed stop=off invites_paused=off reason=none";
  assert.equal((await control("status")).lines[0], opened);
  assert.deepEqual(await events(), [
    ["platform", w.id, id, "invites", "off>on", "system:fleet_breaker"],
    ["platform", null, null, "invites", "on>off", `operator:${OPERATOR}`],
  ]);
});

test("an unknown subcommand or option, a change without --operator, breaker without reopen or with a scope, --platform with --workspace, or an operator name with a space or outside the pattern exits 2 with the usage; an unknown workspace or another workspace's account exits 1; neither changes anything", async () => {
  const [w, other] = [await tenant(), await tenant()];
  const { id } = await createConnectedAccount(other.id);
  const before = await everything();
  const usage = [
    [],
    ["reboot", ...BY],
    ["sending", "open"],
    ["sending", "maybe", ...BY],
    ["sending", "open", "--operator", "ops anna"],
    ["sending", "open", "--operator", "Ops-Anna"],
    ["sending", "open", "--operator", "-ops"],
    ["sending", "open", "--operator", `o${"x".repeat(64)}`],
    ["sending", "open", "--operator"],
    ["stop", "--platform", "--workspace", w.slug, ...BY],
    ["start", "--platform"],
    ["stop", ...BY],
    ["pause", "--workspace", w.slug],
    ["pause", "--platform", ...BY],
    ["pause", "--account", id, ...BY],
    ["unpause", "--workspace", w.slug, "--colour", "red", ...BY],
    ["status", "now"],
    ["status", ...BY],
    ["breaker", "reopen"],
    ["breaker", ...BY],
    ["breaker", "close", ...BY],
    ["breaker", "reopen", "--platform", ...BY],
    ["breaker", "reopen", "--workspace", w.slug, ...BY],
  ];
  for (const args of usage) {
    const { code, lines } = await control(args);
    assert.equal(code, 2, args.join(" "));
    assert.ok(lines.length > 0, args.join(" "));
    for (const line of lines) assert.match(line, /^usage: pnpm linkedin:control /, args.join(" "));
  }
  assert.deepEqual((await control(["reboot", ...BY])).lines, Object.values(USAGE));
  assert.deepEqual((await control(["sending", "open"])).lines, [USAGE.sending]);
  assert.deepEqual((await control(["breaker", "reopen"])).lines, [USAGE.breaker]);

  const refused = [
    [["pause", "--workspace", "nowhere", ...BY], "workspace_not_found: nowhere"],
    [["pause", "--workspace", "wsp_missing", ...BY], "workspace_not_found: wsp_missing"],
    [["unpause", "--workspace", "Not a slug", ...BY], "workspace_not_found: Not a slug"],
    [["status", "--workspace", "nowhere"], "workspace_not_found: nowhere"],
    [
      ["pause", "--workspace", w.slug, "--account", id, ...BY],
      `sender_account_not_found: ${id} in ${w.id}`,
    ],
    [
      ["unpause", "--workspace", w.id, "--account", "sac_missing", ...BY],
      `sender_account_not_found: sac_missing in ${w.id}`,
    ],
  ] as const;
  for (const [args, line] of refused) {
    assert.deepEqual(await control(args), { code: 1, lines: [line] }, args.join(" "));
  }
  assert.deepEqual(await everything(), before);
});

test("the built dist/cli/control.js runs with node alone: an unknown subcommand prints every usage line and exits 2", () => {
  const child = spawnSync(process.execPath, ["dist/cli/control.js", "reboot"], {
    cwd: MODULE,
    encoding: "utf8",
  });
  assert.equal(child.status, 2, child.stderr);
  assert.deepEqual(child.stdout.trim().split("\n"), Object.values(USAGE));
});
