// `pnpm linkedin:control <subcommand>` (README.md "The control command", docs/runbook.md): the
// operator opens and closes sending, stops and starts every LinkedIn action on the instance, pauses
// or unpauses a workspace or one of its sender accounts, and reopens the connection requests the
// fleet breaker paused, naming themselves with --operator; `status` prints the switches, with the
// breaker's reason, ids and codes only. A thin layer over the operator's variants of
// domain/controls/, so the routes, the screen and the command apply the same rules and write the
// same control events. It loads linkedin, tenancy, db and platform, and calls no provider. Each line
// starts with a code: changed, unchanged, a refusal's, or the status's platform, workspace, account.
import { parseArgs } from "node:util";
import { isAppError } from "@whytide/platform";
import {
  findWorkspace,
  findWorkspaceBySlug,
  listWorkspaceIds,
  errors as tenancyErrors,
  type Workspace,
} from "@whytide/tenancy";
import {
  type OperatorChange,
  pauseAccountAsOperator,
  readPlatformControls,
  readWorkspaceControls,
  reopenInvites,
  setPlatformSwitch,
  setWorkspaceStopAsOperator,
  unpauseAccountAsOperator,
} from "../domain/controls/controls.ts";
import { disconnectClient } from "../domain/store.ts";
import { errors } from "../errors.ts";
import { EXIT, OPERATOR_NAME, USAGE } from "./constants.ts";

export type Print = (line: string) => void;

/** What the arguments ask for: a change, which names its operator, or the status. */
type Command =
  | { readonly kind: "sending" | "platform"; readonly on: boolean; readonly operator: string }
  | {
      readonly kind: "workspace";
      readonly on: boolean;
      readonly operator: string;
      readonly workspace: string;
      readonly account?: string;
    }
  | { readonly kind: "breaker"; readonly operator: string }
  | { readonly kind: "status"; readonly workspace?: string };
type PlatformChange = Extract<Command, { kind: "sending" | "platform" }>;
type WorkspaceChange = Extract<Command, { kind: "workspace" }>;

const OPTIONS = {
  operator: { type: "string" },
  platform: { type: "boolean" },
  workspace: { type: "string" },
  account: { type: "string" },
} as const;

/**
 * The command with its arguments; the exit code: 0 changed or unchanged, 1 refused, 2 the usage.
 * A refusal or a usage error changes nothing. Any other error is thrown, as identity's commands do.
 */
export async function runControl(args: string[], print: Print): Promise<number> {
  const command = parse(args);
  if (command === null) {
    const [name = ""] = args;
    const known = Object.hasOwn(USAGE, name);
    for (const line of known ? [USAGE[name as keyof typeof USAGE]] : Object.values(USAGE)) {
      print(line);
    }
    return EXIT.usage;
  }
  if (command.kind === "status") return status(command.workspace, print);
  if (command.kind === "breaker") return reopen(command.operator, print);
  if (command.kind === "workspace") return pauseOrUnpause(command, print);
  return platform(command, print);
}

/** sending open or close, stop or start --platform: the platform's row, outside any run. */
async function platform(command: PlatformChange, print: Print): Promise<number> {
  const { kind, on, operator } = command;
  if (kind === "sending") {
    const result = await setPlatformSwitch("sending", on, operator);
    print(`${result}: sending ${on ? "open" : "closed"}`);
  } else {
    const result = await setPlatformSwitch("stop", on, operator);
    print(`${result}: platform ${on ? "stopped" : "started"}`);
  }
  return EXIT.done;
}

/** breaker reopen: the connection requests the fleet breaker paused open again, outside any run. */
async function reopen(operator: string, print: Print): Promise<number> {
  print(`${await reopenInvites(operator)}: invites open`);
  return EXIT.done;
}

/** pause or unpause --workspace, with or without --account: in that workspace's run. */
async function pauseOrUnpause(command: WorkspaceChange, print: Print): Promise<number> {
  const { on, operator, account } = command;
  const workspace = await workspaceNamed(command.workspace);
  if (workspace === null) {
    print(`workspace_not_found: ${command.workspace}`);
    return EXIT.refused;
  }
  const what = account === undefined ? `workspace ${workspace.id}` : `account ${account}`;
  let result: OperatorChange;
  try {
    result =
      account === undefined
        ? await setWorkspaceStopAsOperator(workspace.id, on, operator)
        : await (on ? pauseAccountAsOperator : unpauseAccountAsOperator)(
            workspace.id,
            account,
            operator,
          );
  } catch (error) {
    if (!isAppError(error) || error.code !== errors.sender_account_not_found) throw error;
    print(`sender_account_not_found: ${account} in ${workspace.id}`);
    return EXIT.refused;
  }
  if (result === "paused_by_tester") {
    print(`paused_by_tester: ${what}`);
    return EXIT.refused;
  }
  print(`${result}: ${what} ${on ? "paused" : "unpaused"}`);
  return EXIT.done;
}

/**
 * The platform's switches, then each workspace, by id, with its accounts, oldest first: every
 * workspace tenancy lists, or the one named. Each workspace is read in its own run.
 */
async function status(named: string | undefined, print: Print): Promise<number> {
  const workspaces: Workspace[] = [];
  if (named === undefined) {
    for (const id of await listWorkspaceIds()) {
      const workspace = await findWorkspace(id);
      if (workspace !== null) workspaces.push(workspace);
    }
  } else {
    const workspace = await workspaceNamed(named);
    if (workspace === null) {
      print(`workspace_not_found: ${named}`);
      return EXIT.refused;
    }
    workspaces.push(workspace);
  }
  const { sendingOpen, stopped, invitesPaused, invitesPausedReason } = await readPlatformControls();
  const sending = sendingOpen ? "open" : "closed";
  const invites = `invites_paused=${onOff(invitesPaused)} reason=${invitesPausedReason ?? "none"}`;
  print(`platform: sending=${sending} stop=${onOff(stopped)} ${invites}`);
  for (const { id, slug } of workspaces) {
    const { workspace, accounts } = await readWorkspaceControls(id);
    const stop = `stop=${onOff(workspace.stopped)} source=${workspace.stopSource ?? "none"}`;
    print(`workspace: ${id} slug=${slug} ${stop}`);
    for (const account of accounts) {
      const owner = `workspace=${id} owner=${account.ownerUserId} status=${account.status}`;
      const held = `switch=${onOff(account.killSwitch)} source=${account.killSwitchSource ?? "none"}`;
      print(`account: ${account.id} ${owner} ${held}`);
    }
  }
  return EXIT.done;
}

const onOff = (on: boolean) => (on ? "on" : "off");

/**
 * The workspace --workspace names: an id has an underscore, a slug none (tenancy's
 * docs/concepts.md); a value that is neither, or a slug two organizations share, names none.
 */
async function workspaceNamed(named: string): Promise<Workspace | null> {
  try {
    return named.includes("_") ? await findWorkspace(named) : await findWorkspaceBySlug(named);
  } catch (error) {
    if (isAppError(error) && error.code === tenancyErrors.tenancy_input_invalid) return null;
    throw error;
  }
}

/** The arguments as a command, or null for a usage error: each subcommand takes its own options. */
function parse(args: string[]): Command | null {
  const parsed = parseOptions(args);
  if (parsed === null) return null;
  const [name, word, ...rest] = parsed.positionals;
  const { operator, platform = false, workspace, account } = parsed.values;
  if (rest.length > 0) return null;
  if (name === "status") {
    const plain = word === undefined && operator === undefined && !platform;
    return plain && account === undefined ? { kind: "status", workspace } : null;
  }
  if (operator === undefined || !OPERATOR_NAME.test(operator)) return null;
  if (name === "sending") {
    const plain = !platform && workspace === undefined && account === undefined;
    const known = word === "open" || word === "close";
    return plain && known ? { kind: "sending", on: word === "open", operator } : null;
  }
  if (name === "breaker") {
    const plain = !platform && workspace === undefined && account === undefined;
    return plain && word === "reopen" ? { kind: "breaker", operator } : null;
  }
  if (word !== undefined) return null;
  if (name === "stop" || name === "start") {
    const plain = platform && workspace === undefined && account === undefined;
    return plain ? { kind: "platform", on: name === "stop", operator } : null;
  }
  if ((name === "pause" || name === "unpause") && !platform && workspace !== undefined) {
    return { kind: "workspace", on: name === "pause", operator, workspace, account };
  }
  return null;
}

function parseOptions(args: string[]) {
  try {
    return parseArgs({ args, options: OPTIONS, allowPositionals: true });
  } catch {
    return null; // an unknown option, an option without its value, or a value given to --platform
  }
}

if (import.meta.main) {
  // On Linux, writes to a pipe or a terminal are synchronous: nothing is lost by exiting here. The
  // module's own client is ended first; exiting ends tenancy's, as identity's commands do.
  let code: number;
  try {
    code = await runControl(process.argv.slice(2), (line) => console.log(line));
  } finally {
    await disconnectClient();
  }
  process.exit(code);
}
