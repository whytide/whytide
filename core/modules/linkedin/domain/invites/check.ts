// The day's check of the pending invitations (README.md "Worker"; docs/flows.md "The pending
// invitations' check"), which the activity linkedin_check_invites runs (workflows/invites.ts) with
// the two provider calls, each made between tenant runs, never inside one. Due once a day for a
// connected account, after its day row's check_after, drawn at random in the window with the row
// (quota/limits.ts), until checked_at is set: so at a different time each day, and the connection
// list is never polled on a schedule (RB-11.2.4). Every call is a read reserved first,
// `pending_invites` for a page of the list and `relation_check` for an invite no longer on it, so it
// counts in the day's reads and in the 200. A refused read stops the check before its call; a port
// error stops it too, the read committed, the account's retry_at and health as a read's error sets
// them, but a person's own (RELATION_GONE_CODES), which closes that invite and goes on. The count and
// the day's checked_at are written in one run, after the last page; a missed acceptance publishes
// linkedin.invite_accepted in the run that sets accepted_at, as the receiver does. Only the invites
// sent since the account's latest pairing are asked about: an older one may be another LinkedIn
// account's. The last step, once the count is written, is the acceptance rule (health/acceptance.ts),
// one run with no call and no read of its own (beta-p6-020), which a retry after the count applies.
import { outboxWriter, tenantClient } from "@whytide/db";
import { type AppError, currentTenant, publish } from "@whytide/platform";
import { events } from "../../events.ts";
import type { ActionOutcome } from "../../schemas/quota.ts";
import { findAccount } from "../accounts.ts";
import { countAction, type LoggedAction, logAction, outcomeOf } from "../action-log/log.ts";
import { now } from "../clock.ts";
import { type Acceptance, applyAcceptanceRule } from "../health/acceptance.ts";
import { afterPortError } from "../health/signals.ts";
import { dayOf } from "../quota/days.ts";
import { lockAccountRow } from "../quota/holds.ts";
import { commitReads, reserveReads } from "../quota/reservations.ts";
import { effectOf, pauseAccount, retryAfterOf } from "../send/outcome.ts";
import type { Logged } from "../send/step.ts";
import { PENDING_INVITES_MAX, RELATION_GONE_CODES } from "./constants.ts";
import {
  type InvitedRow,
  missedOf,
  type PendingInvite,
  type Relation,
  relationOutcome,
} from "./pending.ts";

/** The check's answer: counts and codes only, never a ref. */
export type InvitesChecked =
  /** Not due; on a retry after today's count, with the acceptance rule's numbers. */
  | { readonly due: false; readonly acceptance?: Acceptance }
  | {
      readonly due: true;
      readonly pending: number;
      readonly accepted: number;
      readonly checked: number;
      /** The acceptance rule's numbers, measured once the count is written. */
      readonly acceptance: Acceptance;
    }
  | { readonly due: true; readonly refused: ActionOutcome };
/** A provider call's answer, or the port's error, which is an answer here, never a throw. */
export type Called<T> = { readonly ok: T } | { readonly failed: AppError };
/** A page of the vendor's pending invitations. */
export type PendingPage = {
  readonly invites: readonly PendingInvite[];
  readonly nextCursor: string | null;
};
/** What the activity gives the check: its tenant runs, and the two calls with the reference opened. */
export type CheckCalls = {
  readonly tenant: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly listPendingInvites: (cursor: string | undefined) => Promise<Called<PendingPage>>;
  readonly getRelation: (memberRef: string) => Promise<Called<Relation>>;
};
type Due = {
  readonly dayId: string;
  /** The pairing the check began with: after another pairing, it writes nothing. */
  readonly connectedAt: Date | null;
  /** When it began: the invites committed since, of any day's reservation, are added to the count. */
  readonly startedAt: Date;
};
type ReadKind = "pending_invites" | "relation_check";
type MissedRow = InvitedRow & { readonly providerMemberRef: string };

/**
 * The check: not due, `{ due: false }` and no call. Else the list, a read for each page, to its last
 * page or past PENDING_INVITES_MAX; the count written; then, with the whole list read, a read and a
 * relation for each invite no longer on it, until a read is refused or fails; then the acceptance
 * rule. A refused read or a port error on the list writes no count and answers its code; the next
 * hourly run asks again. A retry (`attempt` 2 and on) that finds today's count written applies the
 * rule, which the attempt that threw after the count may have missed (beta-p6-040).
 */
export async function checkInvites(
  calls: CheckCalls,
  accountId: string,
  attempt = 1,
): Promise<InvitesChecked> {
  const { tenant } = calls;
  const due = await tenant(() => dueOf(accountId));
  if (due === null) {
    if (attempt === 1 || !(await tenant(() => checkedToday(accountId)))) return { due: false };
    const acceptance = await tenant(() => applyAcceptanceRule(tenantClient, accountId, now()));
    return { due: false, acceptance };
  }
  const listed: PendingInvite[] = [];
  let cursor: string | undefined;
  let complete = false;
  while (!complete && listed.length <= PENDING_INVITES_MAX) {
    const kind = "pending_invites";
    const read = await tenant(() => reserveReads({ accountId, count: 1, kind }));
    if ("refused" in read) return { due: true, refused: read.refused };
    const page = await calls.listPendingInvites(cursor);
    if ("failed" in page) {
      const failed = page.failed;
      const refused = await counted(tenant, () => readFailed(accountId, kind, read, failed));
      return { due: true, refused };
    }
    await counted(tenant, () => readMade(accountId, kind, read.reservationId));
    listed.push(...page.ok.invites);
    cursor = page.ok.nextCursor ?? undefined;
    complete = page.ok.nextCursor === null;
  }
  const pending = await tenant(() => writeCount(accountId, due, listed.length));
  if (pending === null) return { due: true, refused: "linkedin_account_disconnected" };
  const missed = complete ? await findMissed(calls, accountId, due, listed) : NONE_MISSED;
  // The rule after the missed acceptances, so that one found today counts today.
  const acceptance = await tenant(() => applyAcceptanceRule(tenantClient, accountId, now()));
  return { due: true, pending, ...missed, acceptance };
}

const NONE_MISSED = { accepted: 0, checked: 0 } as const;

/**
 * A read and a relation for each invite off the list, oldest first, until a read is refused or fails:
 * the acceptances found and the relations asked. A person's own error (RELATION_GONE_CODES, a profile
 * deleted) closes that invite, as a gone relation does, and the pass goes on to the next.
 */
async function findMissed(
  calls: CheckCalls,
  accountId: string,
  due: Due,
  listed: readonly PendingInvite[],
): Promise<{ accepted: number; checked: number }> {
  const { tenant } = calls;
  let accepted = 0;
  let checked = 0;
  for (const row of await tenant(() => missedRows(accountId, due, listed))) {
    const kind = "relation_check";
    const objectRef = row.personId;
    const read = await tenant(() => reserveReads({ accountId, count: 1, kind, objectRef }));
    if ("refused" in read) break;
    const relation = await calls.getRelation(row.providerMemberRef);
    if ("failed" in relation) {
      const failed = relation.failed;
      const gone = RELATION_GONE_CODES.includes(outcomeOf(failed));
      await counted(tenant, () => relationFailed(accountId, row, read, failed, gone));
      if (!gone) break;
      checked += 1;
      continue;
    }
    checked += 1;
    if (
      await counted(tenant, () => relationRead(accountId, row, read.reservationId, relation.ok))
    ) {
      accepted += 1;
    }
  }
  return { accepted, checked };
}

/** `fn` in one tenant run, its log rows counted once the run has returned. */
async function counted<T>(tenant: CheckCalls["tenant"], fn: () => Promise<Logged<T>>): Promise<T> {
  const { answer, logged } = await tenant(fn);
  for (const row of logged) countAction(row);
  return answer;
}

/**
 * Due when the account is `connected` and today's row, made when missing as remainingToday makes
 * it, has check_after passed and checked_at null; else null.
 */
async function dueOf(accountId: string): Promise<Due | null> {
  const account = await findAccount(accountId);
  if (account.status !== "connected") return null;
  const at = now();
  const day = await dayOf(account, at, false);
  const { checkAfter, checkedAt } = day;
  if (checkAfter === null || checkAfter > at || checkedAt !== null) return null;
  const { connectedAt } = await tenantClient.senderAccount.findFirstOrThrow({
    where: { id: accountId },
    select: { connectedAt: true },
  });
  return { dayId: day.id, connectedAt, startedAt: at };
}

/** Whether today's row, the day in use, has its count written: checked_at set. */
async function checkedToday(accountId: string): Promise<boolean> {
  const account = await findAccount(accountId);
  if (account.status !== "connected") return false;
  return (await dayOf(account, now(), false)).checkedAt !== null;
}

/** A read made: committed, and its `ok` row. */
async function readMade(
  accountId: string,
  kind: ReadKind,
  readId: string,
  objectRef?: string,
): Promise<Logged<null>> {
  await commitReads(readId, 1);
  return { answer: null, logged: [await logRead(accountId, kind, objectRef, "ok")] };
}

/**
 * A port error on a read, as a check's (send/check.ts checkFailed): the code logged; retry_at as the
 * error map says and the account's health (health/signals.ts), a warning pausing it and the row
 * counting towards the third error; then the read committed, the account's row locked before the
 * day's, the order applyHealth keeps.
 */
async function readFailed(
  accountId: string,
  kind: ReadKind,
  read: { readonly reservationId: string },
  error: AppError,
  objectRef?: string,
): Promise<Logged<ActionOutcome>> {
  const refused = outcomeOf(error);
  const logged = [await logRead(accountId, kind, objectRef, refused)];
  await pauseAccount(accountId, effectOf(error).account, retryAfterOf(error));
  await afterPortError(accountId, error, now());
  await commitReads(read.reservationId, 1);
  return { answer: refused, logged };
}

/**
 * The count written in one run with the day's checked_at: the invitations listed, plus the invites
 * committed since the check began, whatever day reserved them (a late commit's too). Nothing, and
 * null, when the account was paired again meanwhile (another LinkedIn account may be behind it now)
 * or is no longer connected. The account's row is locked first, as an invite's commit locks it, so an
 * invite committed meanwhile is either counted here or waits, and adds itself to the count once
 * written.
 */
async function writeCount(accountId: string, due: Due, listed: number): Promise<number | null> {
  const at = now();
  await lockAccountRow(accountId);
  const since = await tenantClient.senderQuotaReservation.count({
    where: {
      senderAccountId: accountId,
      actionType: "invite",
      status: { in: ["committed", "committed_late"] },
      settledAt: { gte: due.startedAt },
    },
  });
  const pending = listed + since;
  const { count } = await tenantClient.senderAccount.updateMany({
    where: { id: accountId, status: "connected", connectedAt: due.connectedAt },
    data: { pendingInvites: pending, pendingInvitesCheckedAt: at },
  });
  if (count === 0) return null;
  await tenantClient.senderQuotaUsage.updateMany({
    where: { id: due.dayId, checkedAt: null },
    data: { checkedAt: at },
  });
  return pending;
}

/**
 * The account's invites the vendor no longer lists: its outreach rows invited since its latest
 * pairing (one before it may be another LinkedIn account's, which this one would read as connected),
 * neither accepted nor withdrawn nor asked already, whose invitation and member are off the list,
 * oldest first.
 */
async function missedRows(
  accountId: string,
  due: Due,
  pending: readonly PendingInvite[],
): Promise<MissedRow[]> {
  const rows = await tenantClient.senderOutreach.findMany({
    where: {
      senderAccountId: accountId,
      invitedAt: due.connectedAt === null ? { not: null } : { gte: due.connectedAt },
      acceptedAt: null,
      withdrawnAt: null,
      relationCheckedAt: null,
    },
    select: { id: true, personId: true, providerMemberRef: true, providerInvitationRef: true },
    orderBy: { invitedAt: "asc" },
  });
  return missedOf(rows, pending);
}

/**
 * The relation's run: the read committed and logged; connected, the acceptance and
 * relation_checked_at set and linkedin.invite_accepted published, once (after a webhook's acceptance,
 * nothing); neither connected nor pending, relation_checked_at set, so it is asked once; pending,
 * nothing. Whether an acceptance was detected.
 */
async function relationRead(
  accountId: string,
  row: MissedRow,
  readId: string,
  relation: Relation,
): Promise<Logged<boolean>> {
  const { logged } = await readMade(accountId, "relation_check", readId, row.personId);
  const outcome = relationOutcome(relation);
  if (outcome === "pending") return { answer: false, logged };
  const at = now();
  if (outcome === "gone") {
    const data = { relationCheckedAt: at };
    await tenantClient.senderOutreach.updateMany({ where: { id: row.id }, data });
    return { answer: false, logged };
  }
  const { count } = await tenantClient.senderOutreach.updateMany({
    where: { id: row.id, acceptedAt: null },
    data: { acceptedAt: at, acceptedDetectedAt: at, relationCheckedAt: at },
  });
  if (count === 0) return { answer: false, logged };
  const detectedAt = at.toISOString();
  const payload = {
    sender_account_id: accountId,
    person_id: row.personId,
    detected_at: detectedAt,
  };
  const outbox = outboxWriter(tenantClient, currentTenant().workspaceId);
  await publish(outbox, events["linkedin.invite_accepted"], payload);
  return { answer: true, logged };
}

/**
 * A relation's port error, as readFailed has it; a person's own (`gone`, a profile deleted) also sets
 * relation_checked_at, as a gone relation does, so the invite is asked once.
 */
async function relationFailed(
  accountId: string,
  row: MissedRow,
  read: { readonly reservationId: string },
  error: AppError,
  gone: boolean,
): Promise<Logged<ActionOutcome>> {
  const failed = await readFailed(accountId, "relation_check", read, error, row.personId);
  if (gone) {
    const data = { relationCheckedAt: now() };
    await tenantClient.senderOutreach.updateMany({ where: { id: row.id }, data });
  }
  return failed;
}

const logRead = (
  accountId: string,
  kind: ReadKind,
  objectRef: string | undefined,
  outcome: ActionOutcome,
): Promise<LoggedAction> => logAction({ accountId, kind, objectRef, count: 1, outcome });
