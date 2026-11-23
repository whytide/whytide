// email's test hooks (README.md "Testing"), `@whytide/email/testing`, for tests only: the module's
// own client (useEmailClient(asRole("app")) makes the callback's runs use the test file's schema),
// its secret keys (useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() })) seals, derives
// and opens without a key in the environment), its clock and its random bytes, and a connected
// mailbox written straight to the table with real tokens of the mailbox fake, sealed for the
// workspace's organization (tenancy's row), as the callback leaves one.
import { randomUUID } from "node:crypto";
import { newId } from "@whytide/platform";
import {
  codeChallengeFor,
  getAdapter,
  type MailboxFake,
  type MailboxProvider,
  mailboxPort,
  newCodeVerifier,
} from "@whytide/providers";
import { findWorkspace } from "@whytide/tenancy";
import { addressOf } from "../domain/connect.ts";
import { CALLBACK_PATH } from "../domain/constants.ts";
import { sealTokens } from "../domain/provider.ts";
import { client } from "../domain/store.ts";
import { ids } from "../ids.ts";

export { useClock, useRandom } from "../domain/clock.ts";
export { useSecretKeys } from "../domain/provider.ts";
export { useClient as useEmailClient } from "../domain/store.ts";

const REDIRECT_URI = `https://app.whytide.test${CALLBACK_PATH}`;

/**
 * A connected mailbox of `ownerUserId` (one made up unless given) at `address` (a fresh one of
 * example.com unless given), on the fake's grant for it: its tokens are the fake's, so a refresh, a
 * revoke or a send reaches them. `accessExpiresAt` sets the access token's expiry as stored.
 */
export async function createConnectedMailbox(
  workspaceId: string,
  options: {
    provider?: MailboxProvider;
    address?: string;
    timeZone?: string;
    ownerUserId?: string;
    accessExpiresAt?: Date;
  } = {},
): Promise<{ id: string; emailAddress: string; ownerUserId: string }> {
  const { provider = "google", timeZone = "UTC" } = options;
  const address = options.address ?? `member-${randomUUID().slice(0, 8)}@example.com`;
  const ownerUserId = options.ownerUserId ?? `usr_${randomUUID().replaceAll("-", "")}`;
  const workspace = await findWorkspace(workspaceId);
  if (workspace === null) throw new Error(`createConnectedMailbox: no workspace ${workspaceId}`);
  const fake = (await getAdapter(mailboxPort, "fake")) as unknown as MailboxFake;
  const codeVerifier = newCodeVerifier();
  const codeChallenge = codeChallengeFor(codeVerifier);
  const { url } = await fake.createAuthUrl({
    redirectUri: REDIRECT_URI,
    state: "testing",
    codeChallenge,
  });
  fake.consentNext({ address });
  const code = new URL(url).searchParams.get("code") ?? "";
  const grant = await fake.exchangeCode({ code, redirectUri: REDIRECT_URI, codeVerifier });
  const expiresAt = (options.accessExpiresAt ?? grant.accessExpiresAt).toISOString();
  const tokens = { refreshToken: grant.refreshToken, accessToken: grant.accessToken, expiresAt };
  const { emailAddress, domain, isFreeConsumer } = addressOf(address);
  const db = client();
  const { id: sendingDomainId } = await db.sendingDomain.upsert({
    where: { workspaceId_domain: { workspaceId, domain } },
    create: { id: newId(ids.sending_domain), workspaceId, domain },
    update: {},
    select: { id: true },
  });
  const id = newId(ids.mailbox);
  const at = new Date();
  await db.mailbox.create({
    data: {
      id,
      workspaceId,
      ownerUserId,
      sendingDomainId,
      provider,
      emailAddress,
      displayName: "Test Member",
      scopes: [...grant.scopes],
      oauthTokenRef: sealTokens(tokens, workspace.organizationId),
      isFreeConsumer,
      status: "connected",
      timeZone,
      connectedAt: at,
      tokenCheckedAt: at,
    },
  });
  return { id, emailAddress, ownerUserId };
}
