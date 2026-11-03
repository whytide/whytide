// The webhook (README.md "The webhook", docs/flows.md) and an account's status from the provider:
// the webhook, outside any run until the account is found, and the worker's refresh. Every event is
// verified first, by the adapter's parseWebhook, then handled by kind. An account event, alpha's
// three kinds and account.status alike, reads as one status. `connected` with the hosted link's
// providerRef is the pairing: the pending account the link names, its reference sealed, announced.
// Every other status, `connected` without the link's providerRef too (Unipile's OK and
// SYNC_SUCCESS), is set on the accounts the reference's hash finds, in the order the statuses
// arrive, each in one run in the account's workspace that publishes the event when the status
// crosses into `connected` or `disconnected`; a pending account waits for its link. The account's
// health moves in the same run (health/apply.ts): a crossing into `credentials_required` or
// `disconnected` is a lost session, one into `connected` and a pairing a reconnect. A warning,
// `checkpoint` or `restricted`, counted, pauses each account the hash finds, in its own run. A
// person event goes to the receiver (receiver/receive.ts) with the accounts the hash found;
// `ignored` to the dropped events' counter. The reference is sealed here, in the api, which never
// opens it. A status write that would put a LinkedIn account on a second connected row ends the
// account instead (disclosure/member.ts).
import { outboxWriter, type TenantClient } from "@whytide/db";
import { AppError, encryptSecret, publish } from "@whytide/platform";
import {
  type AccountStatusEvent,
  type LinkedinWebhook,
  type LinkedinWebhookEvent,
  linkedinPort,
} from "@whytide/providers";
import { findWorkspace } from "@whytide/tenancy";
import { errors } from "../errors.ts";
import { events } from "../events.ts";
import { linkedinMetrics } from "../metrics.ts";
import type { SenderAccountStatus } from "./accounts.ts";
import { countAction } from "./action-log/log.ts";
import { now } from "./clock.ts";
import {
  announceReplaced,
  endInUse,
  isMemberConflict,
  memberChange,
  replacement,
} from "./disclosure/member.ts";
import { applyHealth } from "./health/apply.ts";
import { linkedin, providerName, REF_PURPOSE, refHash, secretKeys } from "./provider.ts";
import { receive } from "./receiver/receive.ts";
import { client, inWorkspace } from "./store.ts";

/** A run in one workspace: the store's in the api, the activity's context.tenant in the worker. */
export type Run = <T>(fn: (tx: TenantClient) => Promise<T>) => Promise<T>;
type Found = { readonly id: string; readonly workspaceId: string };
type AccountEvent = Exclude<
  LinkedinWebhookEvent,
  { kind: "ignored" | "invite.accepted" | "message.received" }
>;
/** An account event as the status it says, with the link's providerRef of a pairing notify. */
type StatusChange = {
  readonly providerAccountRef: string;
  readonly status: AccountStatusEvent["status"];
  readonly providerRef?: string | undefined;
};

/**
 * A webhook as the api host's route received it, for the adapter `provider` of its path: another
 * adapter than PROVIDER_LINKEDIN, or a signature or body the adapter refuses, is
 * linkedin_webhook_invalid (401) and changes nothing. An account none of ours is ignored.
 */
export async function handleWebhook(provider: string, request: LinkedinWebhook): Promise<void> {
  if (provider !== providerName()) {
    const details = { reason: "provider" };
    throw new AppError(linkedinPort.errors.linkedin_webhook_invalid, { details });
  }
  const event = await (await linkedin()).parseWebhook(request);
  if (event.kind === "ignored") {
    linkedinMetrics["linkedin.events_dropped"].add(1, { kind: event.kind });
    return;
  }
  if (event.kind === "invite.accepted" || event.kind === "message.received") {
    const hash = refHash(provider, event.providerAccountRef);
    return receive(provider, event, await findBy({ providerAccountRefHash: hash }));
  }
  return applyStatus(provider, statusOf(event));
}

/** alpha's three kinds and account.status, as the status each says. */
function statusOf(event: AccountEvent): StatusChange {
  const { providerAccountRef } = event;
  switch (event.kind) {
    case "account.connected":
      return { providerAccountRef, status: "connected", providerRef: event.providerRef };
    case "account.disconnected":
      return { providerAccountRef, status: "disconnected" };
    case "account.credentials_required":
      return { providerAccountRef, status: "credentials_required" };
    case "account.status":
      return { providerAccountRef, status: event.status };
  }
}

/**
 * One status: `connected` with the link's providerRef pairs (completeConnect); a warning pauses
 * each account the reference's hash finds (warn); any other is set on each of them (setStatus).
 */
async function applyStatus(provider: string, change: StatusChange): Promise<void> {
  const { status, providerRef } = change;
  const hash = refHash(provider, change.providerAccountRef);
  if (status === "checkpoint" || status === "restricted") {
    linkedinMetrics["linkedin.account_warnings"].add(1, { status });
    return warn(await findBy({ providerAccountRefHash: hash }), status);
  }
  if (providerRef !== undefined) return completeConnect({ ...change, providerRef });
  for (const account of await findBy({ providerAccountRefHash: hash })) {
    await setStatus((fn) => inWorkspace(account.workspaceId, fn), account, status);
  }
}

/**
 * A warning on each account, in one run in its workspace: restricted (trigger limit_reached) or
 * checkpoint, its cool-down from now (applyHealth); the session's status is left as it is.
 */
async function warn(accounts: readonly Found[], status: "checkpoint" | "restricted") {
  const cause = {
    at: now(),
    trigger: status === "checkpoint" ? "checkpoint" : "limit_reached",
  } as const;
  for (const account of accounts) {
    await inWorkspace(account.workspaceId, (tx) => applyHealth(tx, account.id, status, cause));
  }
}

/**
 * The pairing, `connected` with the hosted link's providerRef, the vendor's notify of the owner's
 * connect: the pending account the link names takes the reference sealed for its organization, its
 * hash, `connected` and connected_at, which only the pairing writes, and member_id_checked_at
 * null: a reused row keeps the previous LinkedIn account's member hash, so it sends nothing until
 * the refresh after the connect reads this one's (send/state.ts); and a reconnect for its health (a
 * lost session's `disconnected` back to `healthy`, a cool-down kept). A pending account whose
 * LinkedIn account is another user's account in the same workspace already ends `disconnected`,
 * its link cleared, and the webhook answers sender_account_in_use (409): the vendor's retry then
 * finds no pending account, and gets 204. An account whose kept member id another connected row holds
 * (it moved away while this one was disconnected) is paired as replaced, the id cleared: the refresh
 * after the connect stores the new one, or ends the account if it is that row's LinkedIn account.
 */
export async function completeConnect(event: {
  readonly providerAccountRef: string;
  readonly providerRef: string;
}): Promise<void> {
  const provider = providerName();
  const hash = refHash(provider, event.providerAccountRef);
  const found = await findBy({ provider, providerLinkRef: event.providerRef });
  let inUse = false;
  for (const account of found) {
    const workspace = await findWorkspace(account.workspaceId);
    if (workspace === null) continue;
    const context = { organizationId: workspace.organizationId, purpose: REF_PURPOSE };
    const sealed = encryptSecret(event.providerAccountRef, context, secretKeys());
    const at = now();
    const pair = async (tx: TenantClient, replaced: boolean) => {
      const before = await tx.senderAccount.findFirst({ where: { id: account.id } });
      if (before?.status !== "pending") return true;
      const other = { providerAccountRefHash: hash, id: { not: account.id } };
      if ((await tx.senderAccount.findFirst({ where: other, select: { id: true } })) !== null) {
        const ended = { status: "disconnected" as const, providerLinkRef: null };
        const data = { ...ended, statusCheckedAt: at, disconnectedAt: at };
        await tx.senderAccount.update({ where: { id: account.id }, data });
        return false;
      }
      await tx.senderAccount.update({
        where: { id: account.id },
        data: {
          status: "connected",
          providerAccountRef: new Uint8Array(sealed),
          providerAccountRefHash: hash,
          providerLinkRef: null,
          statusCheckedAt: at,
          connectedAt: at,
          disconnectedAt: null,
          memberIdCheckedAt: null, // the refresh reads this pairing's member id; no send until then
          ...(replaced ? replacement(null) : {}),
        },
      });
      if (replaced) await announceReplaced(tx, account);
      await announce(tx, account, "connected");
      await applyHealth(tx, account.id, "reconnected", { at, trigger: "manual" });
      return true;
    };
    const run = (replaced: boolean) => inWorkspace(account.workspaceId, (tx) => pair(tx, replaced));
    const paired = await run(false).catch((error: unknown) => {
      if (!isMemberConflict(error)) throw error;
      return run(true);
    });
    if (!paired) inUse = true;
  }
  if (inUse) throw new AppError(errors.sender_account_in_use);
}

/**
 * The status in the account's run; the event when it crosses into `connected` or `disconnected`;
 * the health in the same run, a lost session into `credentials_required` or `disconnected`
 * (trigger session_invalid), a reconnect into `connected` (manual); a refresh (`pairedAt` given)
 * that reads `connected` is a reconnect even with no crossing: a send or a read that found the
 * session lost left the status `connected`, and the vendor may never report it. With the member id's
 * hash a refresh read, the row's member change and member_id_checked_at in the same run, and
 * linkedin.account_replaced for another id (disclosure/member.ts), only while the row's
 * connected_at is still `pairedAt`, the pairing the refresh read before its call: a pairing since
 * means the id is a previous LinkedIn account's. A write the member index refuses ends the account
 * in a second run and answers sender_account_in_use; else null.
 */
export async function setStatus(
  run: Run,
  account: Found,
  status: SenderAccountStatus,
  member?: string | null,
  pairedAt?: Date | null,
): Promise<"sender_account_in_use" | null> {
  const at = now();
  const written = run(async (tx) => {
    const before = await tx.senderAccount.findFirst({ where: { id: account.id } });
    if (before === null || before.status === "pending") return;
    const crossed = before.status !== status;
    const since = crossed && status === "disconnected" ? { disconnectedAt: at } : {};
    const repaired =
      pairedAt !== undefined && before.connectedAt?.getTime() !== pairedAt?.getTime();
    const read = repaired ? undefined : member;
    const change = memberChange(before.memberIdHash, read);
    const checked = typeof read === "string" ? { memberIdCheckedAt: at } : {};
    const data = { status, statusCheckedAt: at, ...since, ...change.data, ...checked };
    await tx.senderAccount.update({ where: { id: account.id }, data });
    if (change.replaced) await announceReplaced(tx, account);
    if (crossed && (status === "connected" || status === "disconnected")) {
      await announce(tx, account, status);
    }
    if (crossed && (status === "credentials_required" || status === "disconnected")) {
      await applyHealth(tx, account.id, "disconnected", { at, trigger: "session_invalid" });
    }
    if (status === "connected" && (crossed || pairedAt !== undefined)) {
      await applyHealth(tx, account.id, "reconnected", { at, trigger: "manual" });
    }
  });
  return written.then(
    () => null,
    async (error: unknown) => {
      if (!isMemberConflict(error)) throw error;
      const logged = await endInUse(run, account);
      if (logged !== null) countAction(logged);
      return "sender_account_in_use" as const;
    },
  );
}

/** The accounts a webhook names, in any workspace: the one read across workspaces, on the client by name. */
function findBy(where: {
  provider?: string;
  providerLinkRef?: string;
  providerAccountRefHash?: string;
}): Promise<Found[]> {
  return client().senderAccount.findMany({ where, select: { id: true, workspaceId: true } });
}

async function announce(tx: TenantClient, account: Found, status: "connected" | "disconnected") {
  const event = events[`linkedin.sender_account_${status}`];
  await publish(outboxWriter(tx, account.workspaceId), event, { sender_account_id: account.id });
}
