// The decrypt entry (docs/security.md): a mailbox's tokens, opened under its organization for the
// time of `fn`, in the worker only. It is the one place a token is opened: the lint rule
// decrypt-in-worker-only refuses @whytide/platform/secrets/worker anywhere but the worker host and a
// module's workflows/, and this module imports it here alone; the api seals the tokens at the
// callback (domain/connect.ts) and never opens them. An access token close to its expiry is refreshed
// first and the tokens sealed again, a rotated refresh token with them. mailbox_token_revoked, from
// the refresh or from `fn`, disconnects the mailbox (markTokenRevoked) and is answered, never thrown.
import type { Prisma, TenantClient } from "@whytide/db";
import { type ActivityContext, AppError, isAppError } from "@whytide/platform";
import { decryptSecret } from "@whytide/platform/secrets/worker";
import { mailboxPort, type PortInstance } from "@whytide/providers";
import { findWorkspace } from "@whytide/tenancy";
import { now } from "../domain/clock.ts";
import { ACCESS_MARGIN_MS, TOKENS_PURPOSE } from "../domain/constants.ts";
import { markTokenRevoked } from "../domain/mailboxes.ts";
import {
  type MailboxTokens,
  mailboxAdapter,
  sealTokens,
  secretKeys,
  type TokensAnswer,
} from "../domain/provider.ts";
import { errors } from "../errors.ts";

/** What the entry needs of an activity's context: the workspace and its runs. */
export type TokenContext = Pick<ActivityContext<TenantClient>, "workspaceId" | "tenant">;
type Mailbox = PortInstance<typeof mailboxPort>;
/** When to refresh the access token before `fn`: close to its expiry, now whatever, or never. */
export type Refresh = "when_expiring" | "now" | "never";
/** A narrowing of the row read: the mailbox as the caller found it, which a row changed since misses. */
export type Narrowing = Pick<Prisma.MailboxWhereInput, "status" | "disconnectedAt">;

/**
 * `fn` with the mailbox's tokens in clear and its provider's adapter; email_mailbox_not_found for a
 * mailbox not in the workspace, and secret_context_mismatch for tokens sealed for another
 * organization. With `narrow`, the row is read under it too, in the same query: a mailbox it misses
 * answers `changed`, never email_mailbox_not_found. The tokens never leave `fn`'s call: no log
 * line, answer or history holds them.
 */
export async function withMailboxTokens<T>(
  context: TokenContext,
  mailboxId: string,
  fn: (tokens: MailboxTokens, mailbox: Mailbox) => Promise<T>,
  refresh: Refresh = "when_expiring",
  narrow?: Narrowing,
): Promise<TokensAnswer<T>> {
  const select = { provider: true, oauthTokenRef: true, connectedAt: true } as const;
  const where = { id: mailboxId, ...narrow };
  const row = await context.tenant((tx) => tx.mailbox.findFirst({ where, select }));
  if (row === null && narrow !== undefined) return { ok: false, reason: "changed" };
  if (row === null) throw new AppError(errors.email_mailbox_not_found);
  if (row.oauthTokenRef === null) return { ok: false, reason: "no_tokens" };
  const workspace = await findWorkspace(context.workspaceId);
  if (workspace === null) throw new AppError(errors.email_mailbox_not_found);
  const { organizationId } = workspace;
  const plain = decryptSecret(
    row.oauthTokenRef,
    { organizationId, purpose: TOKENS_PURPOSE },
    secretKeys(),
  );
  let tokens: MailboxTokens;
  try {
    tokens = JSON.parse(plain.toString("utf8")) as MailboxTokens;
  } finally {
    plain.fill(0);
  }
  const adapter = await mailboxAdapter(row.provider);
  const { connectedAt } = row;
  try {
    const expiring = Date.parse(tokens.expiresAt) - ACCESS_MARGIN_MS <= now().getTime();
    if (refresh === "now" || (refresh === "when_expiring" && expiring)) {
      const fresh = await adapter.refreshAccess({ refreshToken: tokens.refreshToken });
      tokens = {
        refreshToken: fresh.refreshToken ?? tokens.refreshToken,
        accessToken: fresh.accessToken,
        expiresAt: fresh.accessExpiresAt.toISOString(),
      };
      const sealed = sealTokens(tokens, organizationId);
      // The same connection, tokens still held: a reconnect's or a revoke's row stays as it is.
      const where = { id: mailboxId, connectedAt, oauthTokenRef: { not: null } };
      const data = { oauthTokenRef: sealed, tokenCheckedAt: now() };
      await context.tenant((tx) => tx.mailbox.updateMany({ where, data }));
    }
    return { ok: true, value: await fn(tokens, adapter) };
  } catch (error) {
    if (!isAppError(error) || error.code !== mailboxPort.errors.mailbox_token_revoked) throw error;
    await context.tenant(() => markTokenRevoked(mailboxId, now(), { connectedAt }));
    return { ok: false, reason: "token_revoked" };
  }
}
