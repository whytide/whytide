// An account's status from the provider (docs/flows.md): the webhook, outside any run until the
// account is found, and the worker's refresh. The webhook's account is found across workspaces, by
// the pending link's providerRef on account.connected, else by the reference's hash; then each change
// is one run in the account's workspace, publishing the event when the status crosses into
// `connected` or `disconnected`. The reference is sealed here, in the api, which never opens it.
import { outboxWriter, type TenantClient } from "@whytide/db";
import { AppError, encryptSecret, publish } from "@whytide/platform";
import { type LinkedinWebhook, type LinkedinWebhookEvent, linkedinPort } from "@whytide/providers";
import { findWorkspace } from "@whytide/tenancy";
import { events } from "../events.ts";
import type { SenderAccountStatus } from "./accounts.ts";
import { linkedin, providerName, REF_PURPOSE, refHash, secretKeys } from "./provider.ts";
import { client, inWorkspace } from "./store.ts";

/** A run in one workspace: the store's in the api, the activity's context.tenant in the worker. */
export type Run = <T>(fn: (tx: TenantClient) => Promise<T>) => Promise<T>;
type Found = { readonly id: string; readonly workspaceId: string };

const STATUS_OF = {
  "account.disconnected": "disconnected",
  "account.credentials_required": "credentials_required",
} as const;

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
  if (event.kind === "account.connected") return completeConnect(event);
  const hash = refHash(provider, event.providerAccountRef);
  for (const account of await findBy({ providerAccountRefHash: hash })) {
    await setStatus((fn) => inWorkspace(account.workspaceId, fn), account, STATUS_OF[event.kind]);
  }
}

/**
 * account.connected: the reference sealed for the account's organization, its hash, `connected`.
 * The pending account is paired by the link's providerRef (the fake's); without one, by the hash, an
 * account connected before (README.md "Open questions": Unipile's new accounts).
 */
export async function completeConnect(event: LinkedinWebhookEvent): Promise<void> {
  const provider = providerName();
  const hash = refHash(provider, event.providerAccountRef);
  const found =
    event.providerRef === undefined
      ? await findBy({ providerAccountRefHash: hash })
      : await findBy({ provider, providerLinkRef: event.providerRef });
  for (const account of found) {
    const workspace = await findWorkspace(account.workspaceId);
    if (workspace === null) continue;
    const context = { organizationId: workspace.organizationId, purpose: REF_PURPOSE };
    const sealed = encryptSecret(event.providerAccountRef, context, secretKeys());
    const now = new Date();
    await inWorkspace(account.workspaceId, async (tx) => {
      const before = await tx.senderAccount.findFirst({ where: { id: account.id } });
      if (before === null) return;
      await tx.senderAccount.update({
        where: { id: account.id },
        data: {
          status: "connected",
          providerAccountRef: new Uint8Array(sealed),
          providerAccountRefHash: hash,
          providerLinkRef: null,
          statusCheckedAt: now,
          connectedAt: now,
          disconnectedAt: null,
        },
      });
      if (before.status !== "connected") await announce(tx, account, "connected");
    });
  }
}

/** The status in the account's run; the event when it crosses into `connected` or `disconnected`. */
export async function setStatus(run: Run, account: Found, status: SenderAccountStatus) {
  const now = new Date();
  await run(async (tx) => {
    const before = await tx.senderAccount.findFirst({ where: { id: account.id } });
    if (before === null || before.status === "pending") return;
    const crossed = before.status !== status;
    const since = crossed && status === "disconnected" ? { disconnectedAt: now } : {};
    const data = { status, statusCheckedAt: now, ...since };
    await tx.senderAccount.update({ where: { id: account.id }, data });
    if (crossed && (status === "connected" || status === "disconnected")) {
      await announce(tx, account, status);
    }
  });
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
