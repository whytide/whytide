// linkedin's test hooks (README.md "Testing"), `@whytide/linkedin/testing`, for tests only: the
// module's own client, its secret keys and its clock, and a connected account. useLinkedinClient(
// asRole("app")) makes the webhook's lookup and runs use the test file's schema;
// useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() })) seals and opens references
// without a key in the environment; useClock(() => date) sets the time the read quota reads.
import type { Prisma } from "@whytide/db";
import { encryptSecret, newId } from "@whytide/platform";
import { findWorkspace } from "@whytide/tenancy";
import { REF_PURPOSE, refHash, secretKeys } from "../domain/provider.ts";
import { client } from "../domain/store.ts";
import { DEFAULT_WORKING_HOURS, type WorkingHours } from "../domain/working-hours.ts";
import { ids } from "../ids.ts";

export { useClock } from "../domain/clock.ts";
export { useSecretKeys } from "../domain/provider.ts";
export { useClient as useLinkedinClient } from "../domain/store.ts";

/**
 * A connected account written straight to the table, as the webhook leaves one: without a reference,
 * or with `providerAccountRef` sealed for the workspace's organization (tenancy's row, the keys of
 * useSecretKeys), as the fake's `provider`.
 */
export async function createConnectedAccount(
  workspaceId: string,
  settings: {
    ownerUserId?: string;
    timeZone?: string;
    workingHours?: WorkingHours;
    providerAccountRef?: string;
  } = {},
): Promise<{ id: string }> {
  const id = newId(ids.sender_account);
  const { ownerUserId = `usr_${id.slice(4)}`, timeZone = "UTC", providerAccountRef } = settings;
  const workingHours = { ...(settings.workingHours ?? DEFAULT_WORKING_HOURS) };
  const reference =
    providerAccountRef === undefined ? {} : await seal(workspaceId, providerAccountRef);
  await client().senderAccount.create({
    data: {
      id,
      workspaceId,
      ownerUserId,
      label: "LinkedIn",
      provider: "fake",
      status: "connected",
      timeZone,
      workingHours: workingHours as Prisma.InputJsonObject,
      disclosureAcknowledgedAt: new Date(0),
      ...reference,
    },
  });
  return { id };
}

async function seal(workspaceId: string, providerAccountRef: string) {
  const workspace = await findWorkspace(workspaceId);
  if (workspace === null) throw new Error(`createConnectedAccount: no workspace ${workspaceId}`);
  const context = { organizationId: workspace.organizationId, purpose: REF_PURPOSE };
  const sealed = encryptSecret(providerAccountRef, context, secretKeys());
  return {
    providerAccountRef: new Uint8Array(sealed),
    providerAccountRefHash: refHash("fake", providerAccountRef),
  };
}
