// An account's own LinkedIn member id (docs/flows.md "The member id after a connect"; docs/security.md
// "The keyed hash"): kept only as its keyed hash (domain/hash.ts), which the status refresh stores in
// the run that sets the status (domain/status.ts). The partial unique index
// sender_accounts_member_id_hash_connected keeps one LinkedIn account on one connected row across
// workspaces: a status write it refuses ends the row, in a second run, as a user's disconnect does
// (sender_account_in_use). Another member id than the row's is another LinkedIn account behind it: its
// targets start over, its owner accepts the disclosure again (linkedin.account_replaced), and its
// pending invitations are unknown until its next check (domain/invites/).
import { outboxWriter, type Prisma, type TenantClient } from "@whytide/db";
import { publish } from "@whytide/platform";
import { events } from "../../events.ts";
import { type LoggedAction, logAction } from "../action-log/log.ts";
import { INVITES_PER_DAY, MESSAGES_PER_DAY } from "../quota/constants.ts";
import { READS_ONLY_VERSION } from "./constants.ts";

/** The index a second connected row of one LinkedIn account breaks (the migration linkedin_sending_disclosure). */
const MEMBER_INDEX = "sender_accounts_member_id_hash_connected";
type Account = { readonly id: string; readonly workspaceId: string };
type Run = <T>(fn: (tx: TenantClient) => Promise<T>) => Promise<T>;

/** The member index refused the write (Prisma's P2002, naming it): another connected row holds the id. */
export function isMemberConflict(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return code === "P2002" && typeof message === "string" && message.includes(MEMBER_INDEX);
}

/**
 * A replaced account's row: the member id's hash, the targets back to the start, the disclosure to
 * accept, and the pending invitations unknown, so it sends no invite before its next check.
 */
export const replacement = (memberIdHash: string | null) => ({
  memberIdHash,
  inviteTarget: INVITES_PER_DAY.start,
  messageTarget: MESSAGES_PER_DAY.start,
  rampUpdatedOn: null,
  disclosureVersion: READS_ONLY_VERSION,
  personalAccountConfirmedAt: null,
  pendingInvites: null,
  pendingInvitesCheckedAt: null,
});

/**
 * The row's change for the member id's hash a refresh read: none without one (no key, or no id from
 * the provider) or for the same; stored when the row had none; another is a replacement.
 */
export function memberChange(
  before: string | null,
  member: string | null | undefined,
): { readonly data: Prisma.SenderAccountUpdateInput; readonly replaced: boolean } {
  if (member === undefined || member === null || member === before) {
    return { data: {}, replaced: false };
  }
  if (before === null) return { data: { memberIdHash: member }, replaced: false };
  return { data: replacement(member), replaced: true };
}

/** linkedin.account_replaced, in the run of the row's change. */
export async function announceReplaced(tx: TenantClient, account: Account): Promise<void> {
  const payload = { sender_account_id: account.id };
  await publish(
    outboxWriter(tx, account.workspaceId),
    events["linkedin.account_replaced"],
    payload,
  );
}

/**
 * The account whose LinkedIn account another connected row holds, ended in a run of its own:
 * `disconnected`, its sealed reference, its hash and its link cleared, its member id's hash kept, as
 * a user's disconnect leaves it; a `status_check` row sender_account_in_use; and
 * linkedin.sender_account_disconnected unless it was already. The row logged, or null when it is gone.
 */
export function endInUse(run: Run, account: Account): Promise<LoggedAction | null> {
  return run(async (tx) => {
    const before = await tx.senderAccount.findFirst({
      where: { id: account.id },
      select: { status: true },
    });
    if (before === null) return null;
    const at = new Date();
    const was = before.status === "disconnected";
    await tx.senderAccount.update({
      where: { id: account.id },
      data: {
        status: "disconnected",
        providerAccountRef: null,
        providerAccountRefHash: null,
        providerLinkRef: null,
        statusCheckedAt: at,
        disconnectedAt: was ? undefined : at,
      },
    });
    const check = { accountId: account.id, kind: "status_check", count: 1 } as const;
    const logged = await logAction({ ...check, outcome: "sender_account_in_use" });
    if (!was) {
      const disconnected = events["linkedin.sender_account_disconnected"];
      await publish(outboxWriter(tx, account.workspaceId), disconnected, {
        sender_account_id: account.id,
      });
    }
    return logged;
  });
}
