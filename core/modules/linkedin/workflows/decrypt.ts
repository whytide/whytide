// The decrypt entry (docs/security.md): the account's reference, opened under its organization for the
// time of `fn`, in the worker only. The lint rule decrypt-in-worker-only refuses an import of this
// folder from anywhere but the worker host, this module's workflows/ and its tests/; the api seals the
// reference (domain/status.ts) and never opens it. The reads of the next tasks call it in an activity.
import type { TenantClient } from "@whytide/db";
import { type ActivityContext, AppError } from "@whytide/platform";
import { decryptSecret } from "@whytide/platform/secrets/worker";
import { linkedinPort } from "@whytide/providers";
import { findWorkspace } from "@whytide/tenancy";
import { REF_PURPOSE, secretKeys } from "../domain/provider.ts";
import { errors } from "../errors.ts";

/** What the entry needs of an activity's context: the workspace and its runs. */
export type RefContext = Pick<ActivityContext<TenantClient>, "workspaceId" | "tenant">;

/**
 * `fn` with the account's reference in clear; the bytes are zeroed once it settles. An account of
 * another workspace is sender_account_not_found, one without a reference (pending, or disconnected
 * by its user) linkedin_account_disconnected, and a reference sealed for another organization
 * secret_context_mismatch.
 */
export async function withDecryptedRef<T>(
  context: RefContext,
  accountId: string,
  fn: (providerAccountRef: string) => Promise<T>,
): Promise<T> {
  const row = await context.tenant((tx) =>
    tx.senderAccount.findFirst({ where: { id: accountId }, select: { providerAccountRef: true } }),
  );
  if (row === null) throw new AppError(errors.sender_account_not_found);
  if (row.providerAccountRef === null) {
    throw new AppError(linkedinPort.errors.linkedin_account_disconnected);
  }
  const workspace = await findWorkspace(context.workspaceId);
  if (workspace === null) throw new AppError(errors.sender_account_not_found);
  const sealedFor = { organizationId: workspace.organizationId, purpose: REF_PURPOSE };
  const plain = decryptSecret(row.providerAccountRef, sealedFor, secretKeys());
  try {
    return await fn(plain.toString("utf8"));
  } finally {
    plain.fill(0);
  }
}
