// The kill switches and the sending gates (docs/concepts.md "Kill switches"; docs/flows.md "A
// switch"): the platform's row, global and one at most; the workspace's row, a tenant table; each
// account's kill_switch. A reservation reads them in its own run (send/state.ts), never from a cache,
// so a change holds from the next reservation. A change is a compare-and-set from the state it was
// read in, so two calls at once change a switch, and record it, once: one linkedin_control_events
// row in the same run; a call that changes nothing records none. The tester's commands run in the
// request's tenant run. The operator's variants, module-internal for the command (cli/control.ts),
// run in a run of their own in any workspace as the service principal; the platform's switch runs in
// a transaction of its own on the global client outside any run, so that its change and its event
// commit together, and the status reads the platform there too. The fleet breaker pauses the
// invites in the warning's run (health/breaker.ts); only the operator's reopen lifts the pause.
import { type TenantClient, tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { ids } from "../../ids.ts";
import { findAccount, listAccounts, type SenderAccount, type SwitchSource } from "../accounts.ts";
import { now } from "../clock.ts";
import { inGlobal, inWorkspace } from "../store.ts";
import {
  ACCOUNT_STOP,
  NO_PLATFORM_ROW,
  NO_WORKSPACE_ROW,
  PLATFORM_STATES,
  type StopState,
  WORKSPACE_STOP,
} from "./constants.ts";

export type Controls = {
  readonly platform: {
    readonly sendingOpen: boolean;
    readonly stopped: boolean;
    readonly invitesPaused: boolean;
  };
  readonly workspace: { readonly stopped: boolean; readonly stopSource: SwitchSource | null };
};
/** The platform's switches as the operator's status reads them: with the breaker's reason, a trigger. */
export type PlatformStatus = Controls["platform"] & { readonly invitesPausedReason: string | null };
/** A kill switch's refusal: it stops every action through the account, reads included. */
export type StopCode = "platform_stopped" | "workspace_stopped" | "account_stopped";
/** An operator's change: `paused_by_tester`, a tester's stop, is the tester's to lift. */
export type OperatorChange = "changed" | "unchanged" | "paused_by_tester";
type Actor = { readonly type: "user" | "operator"; readonly id: string };
type Change = {
  readonly scope: "platform" | "workspace" | "account";
  readonly control: "sending" | "stop" | "invites";
  readonly from: string;
  readonly to: string;
  readonly actor: Actor;
  readonly at: Date;
  readonly targetWorkspaceId?: string;
  readonly senderAccountId?: string;
};

/** The platform's row, the one at most, and the switches a reservation and the status read. */
const PLATFORM_ROW = {
  where: { singleton: true },
  select: { sendingOpen: true, stopped: true, invitesPaused: true },
} as const;
/** The same row with the breaker's reason, for the operator's status. */
const PLATFORM_STATUS = {
  where: PLATFORM_ROW.where,
  select: { ...PLATFORM_ROW.select, invitesPausedReason: true },
} as const;

const user = (id: string): Actor => ({ type: "user", id });
const operator = (name: string): Actor => ({ type: "operator", id: name });
const changed = (moved: boolean): OperatorChange => (moved ? "changed" : "unchanged");

/** The platform's switches and the workspace's stop, as the caller's run reads them now. */
export async function readControls(): Promise<Controls> {
  const platform = await tenantClient.linkedinPlatformControl.findUnique(PLATFORM_ROW);
  const workspace = await tenantClient.linkedinWorkspaceControl.findFirst({
    select: { stopped: true, stopSource: true },
  });
  return { platform: platform ?? NO_PLATFORM_ROW, workspace: workspace ?? NO_WORKSPACE_ROW };
}

/** The platform's switches outside any run, on the global client: the operator's status. */
export function readPlatformControls(): Promise<PlatformStatus> {
  return inGlobal(async (db) => {
    const row = await db.linkedinPlatformControl.findUnique(PLATFORM_STATUS);
    return row ?? { ...NO_PLATFORM_ROW, invitesPausedReason: null };
  });
}

/** A workspace's stop and its accounts, oldest first, in its own run: the operator's status. */
export function readWorkspaceControls(
  workspaceId: string,
): Promise<{ workspace: Controls["workspace"]; accounts: SenderAccount[] }> {
  return inWorkspace(workspaceId, async () => {
    return { workspace: (await readControls()).workspace, accounts: await listAccounts() };
  });
}

/** The widest kill switch on for the account, or null: the platform's, the workspace's, its own. */
export function stopOf(
  controls: Controls,
  account: Pick<SenderAccount, "killSwitch">,
): StopCode | null {
  if (controls.platform.stopped) return "platform_stopped";
  if (controls.workspace.stopped) return "workspace_stopped";
  return account.killSwitch ? "account_stopped" : null;
}

/**
 * The tester's pause of the account, for any member with linkedin.manage (the route's permission): no
 * action through it from the next reservation, reads included. A paused account stays as it is, the
 * operator's pause the operator's. The account as it stands.
 */
export async function pauseAccount(accountId: string, userId: string): Promise<SenderAccount> {
  const account = await findAccount(accountId);
  if (stateOf(account.killSwitch, account.killSwitchSource) === "off") {
    await moveAccount(account.id, "off", "tester", user(userId));
  }
  return findAccount(account.id);
}

/**
 * The tester's pause lifted, by the account's owner alone (not_account_owner), never the operator's
 * (stopped_by_operator); an account not paused stays as it is. The account as it stands.
 */
export async function unpauseAccount(accountId: string, userId: string): Promise<SenderAccount> {
  const account = await findAccount(accountId);
  if (account.ownerUserId !== userId) throw new AppError(errors.not_account_owner);
  if (stateOf(account.killSwitch, account.killSwitchSource) === "tester") {
    await moveAccount(account.id, "tester", "off", user(userId));
  }
  const after = await findAccount(account.id);
  if (stateOf(after.killSwitch, after.killSwitchSource) === "operator") {
    throw new AppError(errors.stopped_by_operator);
  }
  return after;
}

/**
 * The workspace's "Stop everything", both ways, for any member with linkedin.manage: on, the tester's
 * stop unless one is on already, the operator's staying the operator's; off, the tester's lifted,
 * never the operator's (stopped_by_operator). The controls as they stand.
 */
export async function setWorkspaceStop(stopped: boolean, userId: string): Promise<Controls> {
  const before = (await readControls()).workspace;
  const from = stateOf(before.stopped, before.stopSource);
  if (stopped && from === "off") await moveWorkspace("off", "tester", user(userId));
  if (!stopped && from === "tester") await moveWorkspace("tester", "off", user(userId));
  const after = await readControls();
  if (!stopped && stateOf(after.workspace.stopped, after.workspace.stopSource) === "operator") {
    throw new AppError(errors.stopped_by_operator);
  }
  return after;
}

/** The operator's pause of an account of any workspace; it takes a tester's pause over. */
export function pauseAccountAsOperator(
  workspaceId: string,
  accountId: string,
  name: string,
): Promise<OperatorChange> {
  return inWorkspace(workspaceId, async () => {
    const account = await findAccount(accountId);
    const from = stateOf(account.killSwitch, account.killSwitchSource);
    if (from === "operator") return "unchanged";
    return changed(await moveAccount(account.id, from, "operator", operator(name)));
  });
}

/** The operator's pause of an account lifted; a tester's pause stays, `paused_by_tester`. */
export function unpauseAccountAsOperator(
  workspaceId: string,
  accountId: string,
  name: string,
): Promise<OperatorChange> {
  return inWorkspace(workspaceId, async () => {
    const account = await findAccount(accountId);
    const from = stateOf(account.killSwitch, account.killSwitchSource);
    if (from !== "operator") return from === "tester" ? "paused_by_tester" : "unchanged";
    return changed(await moveAccount(account.id, "operator", "off", operator(name)));
  });
}

/**
 * The operator's stop of any workspace, both ways: on, it takes a tester's stop over; off, it lifts
 * the operator's only, a tester's staying, `paused_by_tester`.
 */
export function setWorkspaceStopAsOperator(
  workspaceId: string,
  stopped: boolean,
  name: string,
): Promise<OperatorChange> {
  return inWorkspace(workspaceId, async () => {
    const { workspace } = await readControls();
    const from = stateOf(workspace.stopped, workspace.stopSource);
    if (stopped) {
      return from === "operator"
        ? "unchanged"
        : changed(await moveWorkspace(from, "operator", operator(name)));
    }
    if (from !== "operator") return from === "tester" ? "paused_by_tester" : "unchanged";
    return changed(await moveWorkspace("operator", "off", operator(name)));
  });
}

/**
 * The operator's switch of the platform, outside any run: sending open or closed, or every LinkedIn
 * action stopped or started. The row is made by the first switch it turns on: no row reads as off.
 * The change and its event are one transaction: a failed event leaves the switch as it was.
 */
export function setPlatformSwitch(
  control: "sending" | "stop",
  on: boolean,
  name: string,
): Promise<"changed" | "unchanged"> {
  return inGlobal(async (db) => {
    const at = now();
    const set = control === "sending" ? { sendingOpen: on } : { stopped: on };
    const from = control === "sending" ? { sendingOpen: !on } : { stopped: !on };
    const data = { ...set, changedBy: name, changedAt: at };
    const where = { singleton: true, ...from };
    let moved = (await db.linkedinPlatformControl.updateMany({ where, data })).count === 1;
    if (!moved && on) {
      const row = { id: newId(ids.linkedin_platform_control), ...data };
      const made = await db.linkedinPlatformControl.createMany({
        data: [row],
        skipDuplicates: true,
      });
      moved = made.count === 1;
    }
    if (!moved) return "unchanged";
    const [off, onState] = PLATFORM_STATES[control];
    const states = on ? { from: off, to: onState } : { from: onState, to: off };
    await record(db, { scope: "platform", control, ...states, actor: operator(name), at });
    return "changed";
  });
}

/**
 * The operator's reopen of the connection requests the fleet breaker paused, outside any run, as the
 * platform's switch is changed: the only way they open again. Not paused, unchanged and no event.
 */
export function reopenInvites(name: string): Promise<"changed" | "unchanged"> {
  return inGlobal(async (db) => {
    const at = now();
    const data = {
      invitesPaused: false,
      invitesPausedReason: null,
      changedBy: name,
      changedAt: at,
    };
    const where = { singleton: true, invitesPaused: true };
    if ((await db.linkedinPlatformControl.updateMany({ where, data })).count === 0) {
      return "unchanged";
    }
    const [off, on] = PLATFORM_STATES.invites;
    const states = { from: on, to: off };
    await record(db, {
      scope: "platform",
      control: "invites",
      ...states,
      actor: operator(name),
      at,
    });
    return "changed";
  });
}

/** A stop's state as the events name it: on without a source reads as the operator's, fail closed. */
function stateOf(on: boolean, source: SwitchSource | null): StopState {
  return on ? (source ?? "operator") : "off";
}

/** The account's stop moved from `from` to `to` if it is still `from`, with its event; whether it moved. */
async function moveAccount(
  accountId: string,
  from: StopState,
  to: StopState,
  actor: Actor,
): Promise<boolean> {
  const moved = await tenantClient.senderAccount.updateMany({
    where: { id: accountId, ...ACCOUNT_STOP[from] },
    data: ACCOUNT_STOP[to],
  });
  if (moved.count === 0) return false;
  const { workspaceId } = currentTenant();
  const at = now();
  const target = { targetWorkspaceId: workspaceId, senderAccountId: accountId };
  await record(tenantClient, { scope: "account", control: "stop", from, to, actor, at, ...target });
  return true;
}

/** The workspace's stop moved as the account's; no row reads as off, so the first stop makes it. */
async function moveWorkspace(from: StopState, to: StopState, actor: Actor): Promise<boolean> {
  const { workspaceId } = currentTenant();
  const at = now();
  const data = { ...WORKSPACE_STOP[to], changedBy: actor.id, changedAt: at };
  const control = tenantClient.linkedinWorkspaceControl;
  let moved = (await control.updateMany({ where: WORKSPACE_STOP[from], data })).count === 1;
  if (!moved && from === "off") {
    const row = { id: newId(ids.linkedin_workspace_control), workspaceId, ...data };
    moved = (await control.createMany({ data: [row], skipDuplicates: true })).count === 1;
  }
  if (!moved) return false;
  const target = { targetWorkspaceId: workspaceId };
  await record(tenantClient, {
    scope: "workspace",
    control: "stop",
    from,
    to,
    actor,
    at,
    ...target,
  });
  return true;
}

/** One control event, on the run's client or the global one. */
async function record(db: TenantClient, change: Change): Promise<void> {
  const { from, to, actor, ...rest } = change;
  await db.linkedinControlEvent.create({
    data: {
      id: newId(ids.linkedin_control_event),
      ...rest,
      fromState: from,
      toState: to,
      actorType: actor.type,
      actor: actor.id,
    },
  });
}
