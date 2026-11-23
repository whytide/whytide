// The connect flow (docs/flows.md "Connect"), as linkedin's connect: the connect route writes a
// connect row and answers the provider's consent address; the callback claims the row, exchanges the
// code outside any run, and stores the mailbox in a new run. The state is `<workspaceId>.<nonce>`,
// the nonce 32 random bytes of which only the SHA-256 is kept. The PKCE verifier is derived from the
// state (deriveSecret), never stored: the callback derives it again from the state it receives. The
// mailbox is the one the exchange proves; the browser never names the address.
import { createHash } from "node:crypto";
import { outboxWriter, type Prisma, type TenantClient, tenantClient } from "@whytide/db";
import {
  AppError,
  currentTenant,
  deriveSecret,
  isAppError,
  newId,
  publish,
  type TenantContext,
} from "@whytide/platform";
import { codeChallengeFor, MAILBOX_SCOPES, type MailboxProvider } from "@whytide/providers";
import { findUser, findWorkspace } from "@whytide/tenancy";
import { errors } from "../errors.ts";
import { events } from "../events.ts";
import { ids } from "../ids.ts";
import { now, random } from "./clock.ts";
import {
  ADDRESS_INDEX,
  CONNECT_STATE_TTL_MS,
  FREE_CONSUMER_DOMAINS,
  NONCE_BYTES,
  OWNER_INDEX,
  STATE_NONCE,
  STATE_WORKSPACE_ID,
  VERIFIER_PURPOSE,
} from "./constants.ts";
import { type Mailbox, shown } from "./mailboxes.ts";
import { mailboxAdapter, sealTokens, secretKeys } from "./provider.ts";
import { inRun } from "./store.ts";

/** A state's workspace and nonce; null for a state not of the form. */
export function parseState(state: string): { workspaceId: string; nonce: string } | null {
  const dot = state.lastIndexOf(".");
  const workspaceId = state.slice(0, dot);
  const nonce = state.slice(dot + 1);
  return dot > 0 && STATE_WORKSPACE_ID.test(workspaceId) && STATE_NONCE.test(nonce)
    ? { workspaceId, nonce }
    : null;
}

/** What the connect row keeps of the state: the nonce's SHA-256, hex. */
export const stateHashOf = (nonce: string): string =>
  createHash("sha256").update(nonce).digest("hex");

/** The state's PKCE verifier: 32 derived bytes in base64url, 43 characters, the shortest RFC 7636 allows. */
export const verifierOf = (state: string): string =>
  deriveSecret(state, { purpose: VERIFIER_PURPOSE }, secretKeys()).toString("base64url");

/** When a connect made at `at` expires. */
export const expiryOf = (at: Date): Date => new Date(at.getTime() + CONNECT_STATE_TTL_MS);

/** The address in lower case and its domain; free consumer when the domain is a public provider's. */
export function addressOf(address: string) {
  const emailAddress = address.trim().toLowerCase();
  const domain = emailAddress.slice(emailAddress.lastIndexOf("@") + 1);
  return { emailAddress, domain, isFreeConsumer: FREE_CONSUMER_DOMAINS.includes(domain) };
}

/** A zone Intl knows, as given; mailbox_time_zone_invalid otherwise. */
export function parseTimeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    throw new AppError(errors.mailbox_time_zone_invalid);
  }
}

/**
 * The connect route, in the request's run: the consent address for the provider, with a fresh state
 * and its challenge, after a connect row that keeps the state's hash. mailbox_exists when the caller's
 * mailbox here is connected.
 */
export async function startConnect(input: {
  readonly provider: MailboxProvider;
  readonly timeZone: string;
  readonly redirectUri: string;
}): Promise<{ url: string }> {
  const timeZone = parseTimeZone(input.timeZone);
  const { workspaceId, principal } = currentTenant();
  const userId = principal.userId;
  const where = { ownerUserId: userId, status: "connected" as const };
  if ((await tenantClient.mailbox.findFirst({ where, select: { id: true } })) !== null) {
    throw new AppError(errors.mailbox_exists);
  }
  const nonce = random(NONCE_BYTES).toString("base64url");
  const state = `${workspaceId}.${nonce}`;
  const at = now();
  await tenantClient.mailboxConnect.create({
    data: {
      id: newId(ids.mailbox_connect),
      workspaceId,
      userId,
      provider: input.provider,
      timeZone,
      stateHash: stateHashOf(nonce),
      expiresAt: expiryOf(at),
      createdAt: at,
    },
  });
  const adapter = await mailboxAdapter(input.provider);
  const codeChallenge = codeChallengeFor(verifierOf(state));
  return adapter.createAuthUrl({ redirectUri: input.redirectUri, state, codeChallenge });
}

/**
 * The callback, in runs of its own (whytide:own-runs): the claim, then the exchange outside any run,
 * then the store. connect_state_invalid for a state unknown, used, expired, another workspace's or
 * another member's; mailbox_connect_failed for an exchange that fails; mailbox_consent_incomplete,
 * after a revoke from memory, for a consent short of sending and reading or with no address;
 * mailbox_in_use for an address connected in another workspace or another member's here, its tokens
 * discarded unrevoked; mailbox_exists when the member connected another mailbox meanwhile.
 */
export async function finishConnect(
  tenant: TenantContext,
  input: { readonly state: string; readonly code: string; readonly redirectUri: string },
): Promise<Mailbox> {
  const parsed = parseState(input.state);
  if (parsed === null || parsed.workspaceId !== tenant.workspaceId) {
    throw new AppError(errors.connect_state_invalid);
  }
  const at = now();
  const userId = tenant.principal.userId;
  const stateHash = stateHashOf(parsed.nonce);
  const connect = await inRun(tenant, async (tx) => {
    const claim = { stateHash, userId, usedAt: null, expiresAt: { gt: at } };
    const { count } = await tx.mailboxConnect.updateMany({ where: claim, data: { usedAt: at } });
    return count === 1 ? tx.mailboxConnect.findFirst({ where: { stateHash } }) : null;
  });
  if (connect === null) throw new AppError(errors.connect_state_invalid);
  const adapter = await mailboxAdapter(connect.provider);
  const grant = await adapter
    .exchangeCode({
      code: input.code,
      redirectUri: input.redirectUri,
      codeVerifier: verifierOf(input.state),
    })
    .catch((error: unknown) => {
      const reason = isAppError(error) ? error.code : "unknown";
      throw new AppError(errors.mailbox_connect_failed, { details: { reason } });
    });
  if (grant.address === null || MAILBOX_SCOPES.some((scope) => !grant.scopes.includes(scope))) {
    await adapter.revokeAccess({ refreshToken: grant.refreshToken }).catch(() => undefined);
    throw new AppError(errors.mailbox_consent_incomplete);
  }
  const workspace = await findWorkspace(tenant.workspaceId);
  if (workspace === null) throw new AppError(errors.connect_state_invalid);
  const user = await findUser(userId);
  const { emailAddress, domain, isFreeConsumer } = addressOf(grant.address);
  const tokens = {
    refreshToken: grant.refreshToken,
    accessToken: grant.accessToken,
    expiresAt: grant.accessExpiresAt.toISOString(),
  };
  const fields = {
    provider: connect.provider,
    displayName: user?.displayName?.trim() || emailAddress.slice(0, emailAddress.indexOf("@")),
    scopes: [...grant.scopes],
    oauthTokenRef: sealTokens(tokens, workspace.organizationId),
    isFreeConsumer,
    status: "connected" as const,
    disconnectedReason: null,
    disconnectedAt: null,
    timeZone: connect.timeZone,
    connectedAt: at,
    tokenCheckedAt: at,
  };
  try {
    return await inRun(tenant, (tx) => store(tx, { userId, emailAddress, domain, fields }));
  } catch (error) {
    throw conflictOf(error) ?? error;
  }
}

type Fields = Omit<
  Prisma.MailboxUncheckedCreateInput,
  "id" | "workspaceId" | "ownerUserId" | "emailAddress" | "sendingDomainId"
>;

/** The mailbox stored: its domain found or made, its row reused for the same address. */
async function store(
  tx: TenantClient,
  input: { userId: string; emailAddress: string; domain: string; fields: Fields },
): Promise<Mailbox> {
  const { workspaceId } = currentTenant();
  const { userId, emailAddress, domain } = input;
  const existing = await tx.mailbox.findFirst({ where: { emailAddress } });
  if (existing !== null && existing.ownerUserId !== userId) {
    throw new AppError(errors.mailbox_in_use);
  }
  if (existing?.status === "connected") throw new AppError(errors.mailbox_exists);
  const { id: sendingDomainId } = await tx.sendingDomain.upsert({
    where: { workspaceId_domain: { workspaceId, domain } },
    create: { id: newId(ids.sending_domain), workspaceId, domain },
    update: {},
    select: { id: true },
  });
  const data = { ...input.fields, sendingDomainId };
  const row =
    existing === null
      ? await tx.mailbox.create({
          data: { id: newId(ids.mailbox), workspaceId, ownerUserId: userId, emailAddress, ...data },
          select: shown,
        })
      : await tx.mailbox.update({ where: { id: existing.id }, data, select: shown });
  const connected = events["email.mailbox_connected"];
  await publish(outboxWriter(tx, workspaceId), connected, { mailbox_id: row.id });
  return row;
}

/** The refusal a unique index's P2002 stands for: an address connected elsewhere, or a second mailbox. */
function conflictOf(error: unknown): AppError | undefined {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (code !== "P2002" || typeof message !== "string") return undefined;
  if (message.includes(OWNER_INDEX)) return new AppError(errors.mailbox_exists);
  if (message.includes(ADDRESS_INDEX) || message.includes("email_address")) {
    return new AppError(errors.mailbox_in_use);
  }
  return undefined;
}
