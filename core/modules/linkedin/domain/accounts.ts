// linkedin's commands and queries on sender accounts for the api's handlers (README.md "API"): each
// runs inside the request's tenant run, on its transaction (tenantClient), so every query is scoped to
// the workspace currentTenant() names (core/packages/db README); connecting, which calls the provider,
// opens its own runs instead. It leaves the account `pending`: only the provider's webhook sets
// `connected` (domain/status.ts pairs them). A connect needs the current risk disclosure accepted and
// the personal-account confirmation (domain/disclosure/), both stored with the pending account.
import { outboxWriter, type Prisma, type TenantClient, tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId, publish, type TenantContext } from "@whytide/platform";
import { z } from "zod";
import { linkedinConfig } from "../config.ts";
import { errors } from "../errors.ts";
import { events } from "../events.ts";
import { ids } from "../ids.ts";
import { DISCLOSURE_VERSION } from "./disclosure/constants.ts";
import { hasHashKey } from "./hash.ts";
import type { HealthState } from "./health/states.ts";
import { linkedin, providerName } from "./provider.ts";
import { inRun } from "./store.ts";
import {
  DEFAULT_WORKING_HOURS,
  parseTimeZone,
  parseWorkingHours,
  type WorkingHours,
} from "./working-hours.ts";

/**
 * Who holds a stop: the tester, through the screen, or the operator, through the command; an
 * account's alone, a member's removal (domain/removed.ts), which only the account's owner lifts.
 */
export type SwitchSource = "tester" | "operator" | "member_removed";
export type SenderAccountStatus =
  | "pending"
  | "connected"
  | "credentials_required"
  | "error"
  | "disconnected";
/** An account as the queries answer it: never its reference, sealed or not. */
export type SenderAccount = {
  readonly id: string;
  readonly ownerUserId: string;
  readonly label: string;
  readonly status: SenderAccountStatus;
  readonly timeZone: string;
  readonly workingHours: WorkingHours;
  readonly dailyReadCap: number;
  /** The connection requests and the messages a day the day's limits are drawn from (domain/quota/). */
  readonly inviteTarget: number;
  readonly messageTarget: number;
  /** No send and no read before it: the provider's rate limit, or an unknown outcome (domain/send/). */
  readonly retryAt: Date | null;
  /** Paused: no LinkedIn action through it, reads included (domain/controls/), and who paused it. */
  readonly killSwitch: boolean;
  readonly killSwitchSource: SwitchSource | null;
  /** The risk disclosure's version its owner accepted, and when they confirmed the account is their own personal one. */
  readonly disclosureVersion: number;
  readonly personalAccountConfirmedAt: Date | null;
  /**
   * Its LinkedIn member id's hash is stored and was read since the latest pairing (domain/disclosure/
   * member.ts): a reconnect's row keeps the previous account's until then. False while
   * LINKEDIN_HASH_KEY is empty: no hash can be matched then. The hash never leaves here.
   */
  readonly memberIdKnown: boolean;
  /** Its health (domain/health/): restricted, checkpoint and disconnected refuse every action. */
  readonly healthState: HealthState;
  /** The invitations pending at the vendor, and when the day's check counted them (domain/invites/). */
  readonly pendingInvites: number | null;
  readonly pendingInvitesCheckedAt: Date | null;
};

/** The hosted link lives this long: the tester connects right after pressing Connect. */
export const LINK_TTL_MIN = 30;
const DEFAULT_LABEL = "LinkedIn";
const shown = {
  id: true,
  ownerUserId: true,
  label: true,
  status: true,
  timeZone: true,
  workingHours: true,
  dailyReadCap: true,
  inviteTarget: true,
  messageTarget: true,
  retryAt: true,
  killSwitch: true,
  killSwitchSource: true,
  disclosureVersion: true,
  personalAccountConfirmedAt: true,
  memberIdHash: true,
  memberIdCheckedAt: true,
  healthState: true,
  pendingInvites: true,
  pendingInvitesCheckedAt: true,
} as const;

/**
 * The hosted link for the principal's own account, after the risk disclosure: `acknowledged` true for
 * DISCLOSURE_VERSION, else disclosure_required, and `personalAccount` true, else
 * personal_account_required. The user's one account in the workspace, new or reused, waits as
 * `pending` for the provider's account.connected webhook, with the version and the confirmation's
 * time, so a repeated connect changes nothing but the link and those. A reused account keeps its
 * member id's hash, which the refresh after the connect compares. `returnTo` is the screen the
 * provider sends the browser back to, with `?connect=done` or `?connect=failed`. Two runs of its own
 * around the provider call, which no run waits on (the route is whytide:own-runs, so not
 * @Idempotent()).
 */
export async function startConnect(
  tenant: TenantContext,
  input: {
    readonly timeZone: string;
    readonly acknowledged: boolean;
    readonly disclosureVersion?: number | undefined;
    readonly personalAccount?: boolean | undefined;
    readonly returnTo: string;
  },
): Promise<{ url: string }> {
  if (input.acknowledged !== true || input.disclosureVersion !== DISCLOSURE_VERSION) {
    throw new AppError(errors.disclosure_required);
  }
  if (input.personalAccount !== true) throw new AppError(errors.personal_account_required);
  const timeZone = parseTimeZone(input.timeZone);
  const { workspaceId } = tenant;
  const ownerUserId = tenant.principal.userId;
  const refuseConnected = async (tx: TenantClient) => {
    const mine = await tx.senderAccount.findFirst({ where: { ownerUserId } });
    if (mine?.status === "connected") throw new AppError(errors.sender_account_exists);
  };
  await inRun(tenant, refuseConnected);
  const link = await (await linkedin()).createHostedAuthLink({
    successUrl: `${input.returnTo}?connect=done`,
    failureUrl: `${input.returnTo}?connect=failed`,
    expiresInMin: LINK_TTL_MIN,
  });
  const acknowledgedAt = new Date();
  const pending = {
    provider: providerName(),
    providerLinkRef: link.providerRef,
    status: "pending" as const,
    timeZone,
    disclosureAcknowledgedAt: acknowledgedAt,
    disclosureVersion: DISCLOSURE_VERSION,
    personalAccountConfirmedAt: acknowledgedAt,
  };
  await inRun(tenant, async (tx) => {
    await refuseConnected(tx); // connected meanwhile, by another tab
    const id = newId(ids.sender_account);
    const workingHours = DEFAULT_WORKING_HOURS as Prisma.InputJsonObject;
    await tx.senderAccount.upsert({
      where: { workspaceId_ownerUserId: { workspaceId, ownerUserId } },
      create: { id, workspaceId, ownerUserId, label: DEFAULT_LABEL, workingHours, ...pending },
      update: pending,
    });
  });
  return { url: link.url };
}

/** The workspace's accounts, oldest first: what the screen and the sources screen read. */
export async function listAccounts(): Promise<SenderAccount[]> {
  const rows = await tenantClient.senderAccount.findMany({ select: shown, orderBy: { id: "asc" } });
  return rows.map(asAccount);
}

/**
 * The label, the zone, the working hours or the daily read cap of an account, each checked:
 * working_hours_invalid or read_cap_invalid otherwise. reserveReads reads the cap at each
 * reservation, so a lowered cap holds from the next one; a raised one holds from the next quota day,
 * whose read allowance is drawn from it (domain/quota/limits.ts).
 */
export async function updateSettings(
  id: string,
  patch: {
    readonly label?: string;
    readonly timeZone?: string;
    readonly workingHours?: WorkingHours;
    readonly dailyReadCap?: number | string;
  },
): Promise<SenderAccount> {
  const account = await findAccount(id);
  const data: Prisma.SenderAccountUpdateInput = {};
  if (patch.label !== undefined) data.label = patch.label;
  if (patch.timeZone !== undefined) data.timeZone = parseTimeZone(patch.timeZone);
  if (patch.workingHours !== undefined) {
    data.workingHours = parseWorkingHours(patch.workingHours) as Prisma.InputJsonObject;
  }
  if (patch.dailyReadCap !== undefined) data.dailyReadCap = parseReadCap(patch.dailyReadCap);
  const row = await tenantClient.senderAccount.update({
    where: { id: account.id },
    data,
    select: shown,
  });
  return asAccount(row);
}

/**
 * Deletes the account's reference and its hash and keeps the row as `disconnected`, with its member
 * id's hash, which a reconnect's refresh compares; publishes linkedin.sender_account_disconnected when
 * it was not already. The vendor's side is removed by hand in alpha (docs/runbook.md).
 */
export async function disconnect(id: string): Promise<void> {
  const account = await findAccount(id);
  const now = new Date();
  await tenantClient.senderAccount.update({
    where: { id: account.id },
    data: {
      status: "disconnected",
      providerAccountRef: null,
      providerAccountRefHash: null,
      providerLinkRef: null,
      statusCheckedAt: now,
      disconnectedAt: account.status === "disconnected" ? undefined : now,
    },
  });
  if (account.status === "disconnected") return;
  const { workspaceId } = currentTenant();
  const payload = { sender_account_id: account.id };
  const disconnected = events["linkedin.sender_account_disconnected"];
  await publish(outboxWriter(tenantClient, workspaceId), disconnected, payload);
}

/**
 * Asks the worker for the account's status now: linkedin.status_refresh_requested in the request's
 * run, whose subscriber (events.ts) starts the refresh. The account as it stands.
 */
export async function requestRefresh(id: string): Promise<SenderAccount> {
  const account = await findAccount(id);
  const { workspaceId } = currentTenant();
  const requested = events["linkedin.status_refresh_requested"];
  await publish(outboxWriter(tenantClient, workspaceId), requested, {
    sender_account_id: account.id,
  });
  return account;
}

/** A whole number from 1 to LINKEDIN_DAILY_READ_CAP_MAX, else read_cap_invalid with that bound. */
function parseReadCap(value: number | string): number {
  const max = linkedinConfig.LINKEDIN_DAILY_READ_CAP_MAX;
  const cap = z.int().positive().max(max).safeParse(value);
  if (cap.success) return cap.data;
  throw new AppError(errors.read_cap_invalid, { details: { fields: ["dailyReadCap"], max } });
}

/**
 * The user's connected account in the run's workspace, or null: a pending or disconnected one, or
 * another user's, is none. Approve enrolls with the approver's own account (campaigns).
 */
export async function senderOf(userId: string): Promise<SenderAccount | null> {
  // Prisma drops an undefined value from a where: unchecked, that would be any user's account.
  if (!userId) return null;
  const found = await tenantClient.senderAccount.findFirst({
    where: { ownerUserId: userId, status: "connected" },
    select: shown,
  });
  return found === null ? null : asAccount(found);
}

/** The account with the id in this workspace, or sender_account_not_found. */
export async function findAccount(id: string): Promise<SenderAccount> {
  // Prisma drops an undefined value from a where: unchecked, that would be any account.
  const found = id
    ? await tenantClient.senderAccount.findFirst({ where: { id }, select: shown })
    : null;
  if (found === null) throw new AppError(errors.sender_account_not_found);
  return asAccount(found);
}

function asAccount(row: {
  id: string;
  ownerUserId: string;
  label: string;
  status: SenderAccountStatus;
  timeZone: string;
  workingHours: Prisma.JsonValue;
  dailyReadCap: number;
  inviteTarget: number;
  messageTarget: number;
  retryAt: Date | null;
  killSwitch: boolean;
  killSwitchSource: SwitchSource | null;
  disclosureVersion: number;
  personalAccountConfirmedAt: Date | null;
  memberIdHash: string | null;
  memberIdCheckedAt: Date | null;
  healthState: HealthState;
  pendingInvites: number | null;
  pendingInvitesCheckedAt: Date | null;
}): SenderAccount {
  const { memberIdHash, memberIdCheckedAt, ...account } = row;
  // Written by this module only, through parseWorkingHours or the default.
  const workingHours = row.workingHours as unknown as WorkingHours;
  const memberIdKnown = hasHashKey() && memberIdHash !== null && memberIdCheckedAt !== null;
  return { ...account, workingHours, memberIdKnown };
}
