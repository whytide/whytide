// linkedin's test hooks (README.md "Testing"), `@whytide/linkedin/testing`, for tests only: the
// module's own client, its secret keys, its clock and its random source, a connected account, an
// outreach row and the switches. useLinkedinClient(asRole("app")) makes the webhook's lookup and runs
// use the test file's schema; useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() })) seals
// and opens references without a key in the environment; useClock(() => date) sets the time the
// quotas and the receiver read, and useRandom(() => number) the numbers a day's limits are drawn
// from; useHashKey(key) keys the member ids' and the event keys' hashes, never with a real key, and
// useHashKey(null) runs as an empty LINKEDIN_HASH_KEY does. Importing this file sets TEST_HASH_KEY,
// as an account sends only with a key (domain/accounts.ts memberIdKnown); useHashKey(undefined) goes
// back to the environment's. useAlertEmail(address) sets the operator's address for the fleet
// breaker's mail, and useAlertEmail(null) runs as an empty LINKEDIN_ALERT_EMAIL does. A schema
// starts with no platform row, so sending closed: openSending() before a send. setHealth writes an
// account's health straight to its row, for the later tasks' tests, createHealthEvent one of its
// health events, and createInvites its invites.
import { randomBytes } from "node:crypto";
import type { Prisma } from "@whytide/db";
import { encryptSecret, newId } from "@whytide/platform";
import { findWorkspace } from "@whytide/tenancy";
import type { SwitchSource } from "../domain/accounts.ts";
import { DISCLOSURE_VERSION } from "../domain/disclosure/constants.ts";
import { memberHash, useHashKey } from "../domain/hash.ts";
import {
  ACTIONS,
  COOLDOWN_STATES,
  type HealthState,
  type HealthTrigger,
} from "../domain/health/states.ts";
import { REF_PURPOSE, refHash, secretKeys } from "../domain/provider.ts";
import { client } from "../domain/store.ts";
import { DEFAULT_WORKING_HOURS, type WorkingHours } from "../domain/working-hours.ts";
import { ids } from "../ids.ts";

export { useClock, useRandom } from "../domain/clock.ts";
export { useHashKey } from "../domain/hash.ts";
export { useAlertEmail } from "../domain/health/mail.ts";
export { useSecretKeys } from "../domain/provider.ts";
export { useClient as useLinkedinClient } from "../domain/store.ts";

/** The hashes' key under test, never a real one: set on import, so an account can send. */
const TEST_HASH_KEY = "linkedin-testing-hash-key-never-a-real-one";
useHashKey(TEST_HASH_KEY);
/** The default pending count's time: never older than 48 hours, so invites pass unless told otherwise. */
const NEVER_STALE = new Date("9999-12-31T00:00:00Z");

/**
 * A connected account written straight to the table, as the webhook leaves one: without a reference,
 * or with `providerAccountRef` sealed for the workspace's organization (tenancy's row, the keys of
 * useSecretKeys), as the fake's `provider`. Ready to send unless told otherwise: the disclosure's
 * `disclosureVersion` (DISCLOSURE_VERSION), the `personalAccount` confirmation (true), its
 * `memberRef`'s hash under useHashKey's key, or with none given a hash no member id has, which a
 * refresh under a key then reads as a replacement (null stores none), and `pendingInvites` (0)
 * counted at `pendingInvitesCheckedAt` (one never stale; null: never counted).
 */
export async function createConnectedAccount(
  workspaceId: string,
  settings: {
    ownerUserId?: string;
    timeZone?: string;
    workingHours?: WorkingHours;
    providerAccountRef?: string;
    disclosureVersion?: number;
    personalAccount?: boolean;
    memberRef?: string | null;
    pendingInvites?: number | null;
    pendingInvitesCheckedAt?: Date | null;
  } = {},
): Promise<{ id: string }> {
  const id = newId(ids.sender_account);
  const { ownerUserId = `usr_${id.slice(4)}`, timeZone = "UTC", providerAccountRef } = settings;
  const { disclosureVersion = DISCLOSURE_VERSION, personalAccount = true } = settings;
  const { pendingInvites = 0, pendingInvitesCheckedAt = NEVER_STALE } = settings;
  const workingHours = { ...(settings.workingHours ?? DEFAULT_WORKING_HOURS) };
  const reference =
    providerAccountRef === undefined ? {} : await seal(workspaceId, providerAccountRef);
  const memberIdHash = memberOf(settings.memberRef);
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
      disclosureVersion,
      personalAccountConfirmedAt: personalAccount ? new Date(0) : null,
      memberIdHash,
      memberIdCheckedAt: memberIdHash === null ? null : new Date(0),
      pendingInvites,
      pendingInvitesCheckedAt,
      ...reference,
    },
  });
  return { id };
}

/** The member id's hash under the test's key; a hash of no member id when none is given. */
function memberOf(memberRef: string | null | undefined): string | null {
  if (memberRef === undefined) return randomBytes(32).toString("hex");
  if (memberRef === null) return null;
  const hash = memberHash(memberRef);
  if (hash === null) throw new Error("createConnectedAccount: a memberRef needs useHashKey(key)");
  return hash;
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

/**
 * An outreach row written straight to the table, as beta-p1-050's send will leave one: the person
 * (an id made up for it unless given) whom the account invited or messaged, with the refs given.
 */
export async function createOutreach(
  workspaceId: string,
  row: {
    senderAccountId: string;
    personId?: string;
    providerMemberRef?: string;
    providerChatRef?: string;
  },
): Promise<{ id: string; personId: string }> {
  const id = newId(ids.sender_outreach);
  const personId = row.personId ?? `per_${id.slice(id.indexOf("_") + 1)}`;
  await client().senderOutreach.create({ data: { ...row, id, workspaceId, personId } });
  return { id, personId };
}

/**
 * The account's invites written straight to the table in one statement, as the sends and the
 * receiver leave them: each at its `invitedAt`, accepted or withdrawn at the times given, to a person
 * made up for it, with no member's ref unless given; for the acceptance rule's tests (beta-p6-020).
 * Their ids and persons, in the order given.
 */
export async function createInvites(
  workspaceId: string,
  senderAccountId: string,
  invites: readonly {
    invitedAt: Date;
    acceptedAt?: Date | null;
    withdrawnAt?: Date | null;
    providerMemberRef?: string;
  }[],
): Promise<{ id: string; personId: string }[]> {
  const rows = invites.map((invite) => {
    const id = newId(ids.sender_outreach);
    const personId = `per_${id.slice(id.indexOf("_") + 1)}`;
    return { ...invite, id, workspaceId, senderAccountId, personId };
  });
  await client().senderOutreach.createMany({ data: rows });
  return rows.map(({ id, personId }) => ({ id, personId }));
}

/** The `changed_by` of a row written here, which writes no control event. */
const SEEDED_BY = "testing";

/**
 * The platform's row written straight to the table, as the operator's command (beta-p1-060) and the
 * fleet breaker (beta-p6-030) leave it, made when missing: the switches given, the others as they
 * were, all off in a new row. No control event: a test's or a seed's state.
 */
export async function setPlatformControls(controls: {
  sendingOpen?: boolean;
  stopped?: boolean;
  invitesPaused?: boolean;
}): Promise<void> {
  const data = { ...controls, changedBy: SEEDED_BY, changedAt: new Date() };
  await client().linkedinPlatformControl.upsert({
    where: { singleton: true },
    create: { id: newId(ids.linkedin_platform_control), ...data },
    update: data,
  });
}

/** Sending open on the instance, nothing else changed: a send's reservation needs it. */
export const openSending = (): Promise<void> => setPlatformControls({ sendingOpen: true });

/** The workspace's stop written straight to the table, held by `source`, or lifted with null. */
export async function setWorkspaceStopped(
  workspaceId: string,
  source: SwitchSource | null,
): Promise<void> {
  const row = {
    stopped: source !== null,
    stopSource: source,
    changedBy: SEEDED_BY,
    changedAt: new Date(),
  };
  await client().linkedinWorkspaceControl.upsert({
    where: { workspaceId },
    create: { id: newId(ids.linkedin_workspace_control), workspaceId, ...row },
    update: row,
  });
}

/** The account's kill switch written straight to its row, held by `source`, or lifted with null. */
export async function setAccountPaused(
  accountId: string,
  source: SwitchSource | null,
): Promise<void> {
  await client().senderAccount.update({
    where: { id: accountId },
    data: { killSwitch: source !== null, killSwitchSource: source },
  });
}

/**
 * The account's health written straight to its row, as applyHealth leaves it but with no event, no
 * outbox row and no released reservation: the state, `health_changed_at` (`at`, now by default) and
 * the cool-down's end, which the database keeps null outside restricted and checkpoint.
 */
export async function setHealth(
  accountId: string,
  state: HealthState,
  options: { pausedUntil?: Date | null; at?: Date } = {},
): Promise<void> {
  const { pausedUntil = null, at = new Date() } = options;
  await client().senderAccount.update({
    where: { id: accountId },
    data: { healthState: state, healthChangedAt: at, pausedUntil },
  });
}

/**
 * One health event of the account written straight to the table as applyHealth writes one (the third
 * error's when `from` is `to`), with no outbox row, so no mail (beta-p6-040).
 */
export async function createHealthEvent(
  accountId: string,
  event: { from: HealthState; to: HealthState; trigger: HealthTrigger; at: Date } & {
    metrics?: Record<string, number | string>;
    pausedUntil?: Date | null;
  },
): Promise<void> {
  const account = await client().senderAccount.findUniqueOrThrow({ where: { id: accountId } });
  const changed = event.from !== event.to;
  await client().senderHealthEvent.create({
    data: {
      id: newId(ids.sender_health_event),
      workspaceId: account.workspaceId,
      senderId: accountId,
      fromState: event.from,
      toState: event.to,
      trigger: event.trigger,
      metrics: event.metrics ?? {},
      automaticAction: changed ? ACTIONS[event.to] : "paused_all_actions",
      pausedUntil: event.pausedUntil ?? null,
      ackRequired: changed && COOLDOWN_STATES.includes(event.to),
      createdAt: event.at,
    },
  });
}
