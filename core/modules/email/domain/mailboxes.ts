// The mailboxes (README.md "API"; docs/flows.md): the list, the owner's disconnect, and the one
// disconnect behind it, a revoked token and a removed member, all in the caller's tenant run
// (tenantClient). A disconnect keeps the row: status, reason and time change, and the tokens stay
// until the worker revokes them (workflows/), except a revoked token's, nulled at once. No answer
// holds a token.
import { outboxWriter, tenantClient } from "@whytide/db";
import { AppError, can, currentTenant, publish } from "@whytide/platform";
import { errors } from "../errors.ts";
import { events } from "../events.ts";
import { permissions } from "../permissions.ts";
import { now } from "./clock.ts";

export type DisconnectReason = "user" | "token_revoked" | "member_removed";

/** What a read selects: never the tokens. */
export const shown = {
  id: true,
  ownerUserId: true,
  provider: true,
  emailAddress: true,
  displayName: true,
  scopes: true,
  isFreeConsumer: true,
  status: true,
  disconnectedReason: true,
  timeZone: true,
  connectedAt: true,
  disconnectedAt: true,
  tokenCheckedAt: true,
} as const;

export type Mailbox = {
  readonly id: string;
  readonly ownerUserId: string;
  readonly provider: "google" | "microsoft";
  readonly emailAddress: string;
  readonly displayName: string;
  readonly scopes: readonly string[];
  readonly isFreeConsumer: boolean;
  readonly status: "connected" | "disconnected";
  readonly disconnectedReason: DisconnectReason | null;
  readonly timeZone: string;
  readonly connectedAt: Date;
  readonly disconnectedAt: Date | null;
  readonly tokenCheckedAt: Date | null;
};

/** The caller's own mailboxes, oldest first, or every mailbox here for a holder of email.manage. */
export async function listMailboxes(): Promise<Mailbox[]> {
  const { principal, workspaceId } = currentTenant();
  const all = can(principal, permissions["email.manage"], { workspaceId }) === "allow";
  const where = all ? {} : { ownerUserId: principal.userId };
  return tenantClient.mailbox.findMany({ where, select: shown, orderBy: { id: "asc" } });
}

/** A mailbox of the run's workspace, or null: the read the later tasks use. */
export function findMailbox(mailboxId: string): Promise<Mailbox | null> {
  return tenantClient.mailbox.findFirst({ where: { id: mailboxId }, select: shown });
}

/**
 * The route's disconnect, the mailbox's owner only: email_mailbox_not_found for a mailbox not here,
 * not_mailbox_owner for another member's. A disconnected one stays as it is.
 */
export async function disconnectOwn(mailboxId: string): Promise<void> {
  const { workspaceId, principal } = currentTenant();
  const found = await findMailbox(mailboxId);
  if (found === null) throw new AppError(errors.email_mailbox_not_found);
  if (found.ownerUserId !== principal.userId) throw new AppError(errors.not_mailbox_owner);
  await disconnectMailbox({ workspaceId, mailboxId, reason: "user", at: now() });
}

/**
 * The one disconnect, in the caller's run in the workspace: a connected mailbox turns `disconnected`
 * with the reason at `at`, and email.mailbox_disconnected is published; for `user` and
 * `member_removed` the worker then revokes the tokens and nulls them (events.ts), for
 * `token_revoked` they are nulled here. A mailbox already disconnected changes nothing.
 */
export async function disconnectMailbox(input: {
  readonly workspaceId: string;
  readonly mailboxId: string;
  readonly reason: DisconnectReason;
  readonly at: Date;
}): Promise<{ disconnected: boolean }> {
  return disconnect(input, {});
}

/**
 * A grant the provider answered mailbox_token_revoked for: the disconnect with `token_revoked` and
 * the tokens nulled at once, in the caller's run. With `connectedAt`, only the connection the tokens
 * came from: a mailbox reconnected since keeps its new tokens.
 */
export function markTokenRevoked(
  mailboxId: string,
  at: Date,
  connection: { readonly connectedAt?: Date } = {},
): Promise<{ disconnected: boolean }> {
  const { workspaceId } = currentTenant();
  const input = { workspaceId, mailboxId, reason: "token_revoked" as const, at };
  return disconnect(input, connection.connectedAt ? { connectedAt: connection.connectedAt } : {});
}

async function disconnect(
  input: Parameters<typeof disconnectMailbox>[0],
  narrow: { connectedAt?: Date },
): Promise<{ disconnected: boolean }> {
  const { workspaceId, mailboxId, reason, at } = input;
  const tokens = reason === "token_revoked" ? { oauthTokenRef: null } : {};
  const { count } = await tenantClient.mailbox.updateMany({
    where: { id: mailboxId, workspaceId, status: "connected", ...narrow },
    data: { status: "disconnected", disconnectedReason: reason, disconnectedAt: at, ...tokens },
  });
  if (count === 0) return { disconnected: false };
  const disconnected = events["email.mailbox_disconnected"];
  await publish(outboxWriter(tenantClient, workspaceId), disconnected, {
    mailbox_id: mailboxId,
    reason,
  });
  return { disconnected: true };
}
