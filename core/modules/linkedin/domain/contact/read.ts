// A lead's "Contact info" emails for an email lookup (README.md "Contact info"; gamma-en-087): the
// owner's exception of 2026-11-13 to the rule against reading that section, for now, behind
// LINKEDIN_CONTACT_INFO_ENABLED, off by default. Called from enrichment's lookup activity, in the
// worker, and the port's getContactEmails' only caller (the providers' never-list safety case fails
// on any other). Off, it answers `disabled` before anything else: no read reserved, no call. On, one
// of the workspace's connected accounts whose invitation the person accepted (sender_outreach's
// accepted_at, with the member's ref) reads it, the one with the most reads left now, its window
// open and nothing pausing it: a `read_profile` read, reserved first, counted in its daily reads and
// actions, inside its working hours, pauses and switches; then the call through the account's
// reference, opened by the worker's decrypt entry (domain/company/read.ts); then the read committed,
// or released on a failure that made no call. Only email addresses come back, lower case, three at
// most. The action log's rows name the person's id, erased with the person (domain/erase.ts); the
// addresses reach no log line, span, metric, row or event here.
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { linkedinPort } from "@whytide/providers";
import { errors } from "../../errors.ts";
import type { ActionOutcome } from "../../schemas/quota.ts";
import { PERSON_ID } from "../../schemas/quota.ts";
import { listAccounts } from "../accounts.ts";
import { countAction, logAction, outcomeOf } from "../action-log/log.ts";
import { now } from "../clock.ts";
import { type CompanyReadContext, type RefOpener, refOpener } from "../company/read.ts";
import { afterPortError } from "../health/signals.ts";
import { linkedin } from "../provider.ts";
import { commitReads, readsLeftToday, releaseReads, reserveReads } from "../quota/reservations.ts";
import { contactInfoEnabled } from "./switch.ts";

/** What readContactEmails needs of its caller: the workspace, and a run of it, one transaction a call. */
export type ContactReadContext = CompanyReadContext;
/**
 * The addresses the person shows in "Contact info" (none, when they show none); or why none was read:
 * the switch off, no connected account the person is connected to, none of those with reads left now.
 */
export type ContactRead =
  | { readonly status: "read"; readonly emails: readonly string[] }
  | { readonly status: "disabled" | "not_connected" | "no_reads_left" };
/** An account the person accepted, and the member's ref there. */
type Reader = { readonly accountId: string; readonly memberRef: string };

const KIND = "read_profile";

/**
 * The person's "Contact info" emails, read through the workspace's account they are connected to;
 * another such account when that one's reservation is refused meanwhile. read_input_invalid naming
 * `personId` for an id of another form; contact_read_unavailable outside the worker. A port error is
 * thrown after its row and its health, as every read's; linkedin_not_found answers no address.
 */
export async function readContactEmails(
  input: { readonly personId: string },
  context: ContactReadContext,
): Promise<ContactRead> {
  if (!contactInfoEnabled()) return { status: "disabled" };
  const open = refOpener();
  if (open === undefined) throw new AppError(errors.contact_read_unavailable);
  if (typeof input.personId !== "string" || !PERSON_ID.test(input.personId)) {
    throw new AppError(errors.read_input_invalid, { details: { fields: ["personId"] } });
  }
  const { personId } = input;
  const { connected, readers } = await context.tenant(() => candidates(personId));
  if (connected === 0) return { status: "not_connected" };
  for (const reader of readers) {
    const reserved = await context.tenant(async () => {
      const answer = await reserveReads({
        accountId: reader.accountId,
        count: 1,
        kind: KIND,
        objectRef: personId,
      });
      return "reservationId" in answer ? answer.reservationId : null;
    });
    if (reserved === null) continue;
    return read(open, context, { ...reader, personId, reservationId: reserved });
  }
  return { status: "no_reads_left" };
}

/**
 * The connected accounts the person accepted, and those that may read now, the most reads left
 * first. A row never accepted, or without the member's ref, is no connection.
 */
async function candidates(personId: string): Promise<{ connected: number; readers: Reader[] }> {
  const rows = await tenantClient.senderOutreach.findMany({
    where: { personId, acceptedAt: { not: null }, providerMemberRef: { not: null } },
    select: { senderAccountId: true, providerMemberRef: true },
    orderBy: { id: "asc" },
  });
  const accepted = new Map(rows.map((row) => [row.senderAccountId, row.providerMemberRef ?? ""]));
  const accounts = (await listAccounts()).filter(
    (account) => account.status === "connected" && accepted.has(account.id),
  );
  const left: [Reader, number][] = [];
  for (const account of accounts) {
    const reads = await readsLeftToday(account.id);
    if (!reads.windowOpen || reads.left === 0) continue;
    left.push([{ accountId: account.id, memberRef: accepted.get(account.id) ?? "" }, reads.left]);
  }
  const readers = left.toSorted((a, b) => b[1] - a[1]).map(([reader]) => reader);
  return { connected: accounts.length, readers };
}

/** The call on the reserved read, its row, and the read committed, or released without a call. */
async function read(
  open: RefOpener,
  context: ContactReadContext,
  held: Reader & { readonly personId: string; readonly reservationId: string },
): Promise<ContactRead> {
  const adapter = await linkedin();
  let called = false;
  try {
    const { emails } = await open(context, held.accountId, (providerAccountRef) => {
      called = true;
      return adapter.getContactEmails({ providerAccountRef, memberRef: held.memberRef });
    });
    await settle(context, held, "ok");
    return { status: "read", emails };
  } catch (error) {
    if (!called) {
      await context.tenant(() => releaseReads(held.reservationId));
      throw error;
    }
    await settle(context, held, outcomeOf(error), error);
    if (outcomeOf(error) === linkedinPort.errors.linkedin_not_found) {
      return { status: "read", emails: [] };
    }
    throw error;
  }
}

/** The call's row, a port error's health, and the read committed, in one run; then the metric. */
async function settle(
  context: ContactReadContext,
  held: { readonly accountId: string; readonly personId: string; readonly reservationId: string },
  outcome: ActionOutcome,
  error?: unknown,
): Promise<void> {
  const { accountId, personId, reservationId } = held;
  const logged = await context.tenant(async () => {
    const row = await logAction({ accountId, kind: KIND, objectRef: personId, count: 1, outcome });
    if (error !== undefined) await afterPortError(accountId, error, now());
    await commitReads(reservationId, 1);
    return row;
  });
  countAction(logged);
}
