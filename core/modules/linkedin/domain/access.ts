// Who may do what with a sender account (gamma-p6-070; README "API", docs/security.md "Who sees
// which account"): its owner, any member, everything that is theirs; a holder of linkedin.manage, an
// Owner or an Admin by platform's can(), sees every account, its usage and its health, and pauses
// it. Who lifts a pause: a tester's, its owner or a holder of linkedin.manage; a removed member's, its
// owner alone; the operator's, no one here (stopped_by_operator, controls/controls.ts). The routes,
// the list's flags and the kill switches ask these, so the rule lives in one place; a service's run,
// the worker's or a test's, holds linkedin.manage.
import { AppError, can, currentTenant, type Principal } from "@whytide/platform";
import { listMembers } from "@whytide/tenancy";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import { findAccount, listAccounts, type SenderAccount } from "./accounts.ts";

type Owned = Pick<SenderAccount, "ownerUserId">;
type Stop = Pick<SenderAccount, "ownerUserId" | "killSwitch" | "killSwitchSource">;

/** What the caller may do with an account: the answer's flags. */
export type AccountAccess = {
  readonly mine: boolean;
  readonly canManage: boolean;
  readonly canEdit: boolean;
  readonly canPause: boolean;
  readonly canUnpause: boolean;
};

/** can()'s answer for linkedin.manage in the run's workspace: `allow` for an Owner, an Admin, a service. */
function manage(principal: Principal) {
  const { workspaceId } = currentTenant();
  return can(principal, permissions["linkedin.manage"], { workspaceId });
}

/** Whether the principal holds linkedin.manage in the run's workspace. */
export const manages = (principal: Principal): boolean => manage(principal) === "allow";

/** Whether the account is the principal's own. */
export const owns = (principal: Principal, account: Owned): boolean =>
  account.ownerUserId === principal.userId;

/** Whether the principal sees the account, its usage and its health, and pauses it. */
export const sees = (principal: Principal, account: Owned): boolean =>
  owns(principal, account) || manages(principal);

/** Whether the principal may lift the account's pause now; on without a source is the operator's. */
export function mayUnpause(principal: Principal, account: Stop): boolean {
  if (!account.killSwitch) return false;
  if (account.killSwitchSource === "tester") return sees(principal, account);
  return account.killSwitchSource === "member_removed" && owns(principal, account);
}

/** The flags of the account's answer for the principal. */
export function accessOf(principal: Principal, account: Stop): AccountAccess {
  const mine = owns(principal, account);
  return {
    mine,
    canManage: manages(principal),
    canEdit: mine,
    canPause: !account.killSwitch && sees(principal, account),
    canUnpause: mayUnpause(principal, account),
  };
}

/** forbidden (403) unless the principal holds linkedin.manage: the workspace's "Stop everything". */
export function assertManager(principal: Principal): void {
  const decision = manage(principal);
  if (decision !== "allow") throw new AppError(decision);
}

/** The account once it is the principal's own; sender_account_not_found first, then not_account_owner. */
export async function ownAccount(principal: Principal, accountId: string): Promise<SenderAccount> {
  const account = await findAccount(accountId);
  if (!owns(principal, account)) throw new AppError(errors.not_account_owner);
  return account;
}

/** The account once the principal sees it, its owner or a manager; else not_account_owner. */
export async function seenAccount(principal: Principal, accountId: string): Promise<SenderAccount> {
  const account = await findAccount(accountId);
  if (!sees(principal, account)) throw new AppError(errors.not_account_owner);
  return account;
}

/** The accounts the principal sees, oldest first: a Member's own, a manager's every one. */
export async function visibleAccounts(principal: Principal): Promise<SenderAccount[]> {
  const accounts = await listAccounts();
  return manages(principal) ? accounts : accounts.filter((account) => owns(principal, account));
}

/**
 * The workspace's active members' names by user id, the display name else the email: one read of
 * tenancy's listMembers in the caller's run. A removed member is not among them.
 */
export async function ownerNames(): Promise<ReadonlyMap<string, string>> {
  const members = await listMembers();
  return new Map(members.map(({ userId, displayName, email }) => [userId, displayName || email]));
}
