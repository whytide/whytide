// A company page read for enrichment (README.md "Company pages"; gamma-en-060), called from an
// activity of the worker: one of the workspace's connected accounts reads the page, whoever's lead it
// is, since a page read sends nothing and shows nothing to the company. Like every read, it is
// reserved first (`read_company`, 1), counts in the account's daily reads and actions, inside its
// working hours and pauses, and within its share (share.ts); then the port's getCompany, outside any
// run, through the account's reference, opened by the worker's decrypt entry; then the read
// committed, or released on a failure that made no call. The reference is opened only where the
// worker registered its entry (useRefOpener, from workflows/index.ts): the api, which never decrypts,
// has none and answers company_read_unavailable. The page's link and its facts go to no log line,
// span, metric or action-log row: the row names no object.
import { AppError } from "@whytide/platform";
import { type LinkedinCompany, linkedinPort } from "@whytide/providers";
import { errors } from "../../errors.ts";
import type { ActionOutcome } from "../../schemas/quota.ts";
import { listAccounts, type SenderAccount } from "../accounts.ts";
import { countAction, logAction, outcomeOf } from "../action-log/log.ts";
import { now } from "../clock.ts";
import { afterPortError } from "../health/signals.ts";
import { linkedin } from "../provider.ts";
import { dayOf } from "../quota/days.ts";
import { commitReads, readsLeftToday, releaseReads, reserveReads } from "../quota/reservations.ts";
import { companyReadsLeft } from "./share.ts";

/** What readCompany needs of its caller: the workspace, and a run of it, one transaction a call. */
export type CompanyReadContext = {
  readonly workspaceId: string;
  readonly tenant: <T>(fn: () => Promise<T>) => Promise<T>;
};
/** The page's facts; or why none: no connected account, none with reads left now, no such page. */
export type CompanyRead =
  | { readonly status: "read"; readonly company: LinkedinCompany }
  | { readonly status: "no_account" | "no_reads_left" | "not_found" };
/** The worker's decrypt entry: `fn` with the account's reference in clear. */
export type RefOpener = <T>(
  context: CompanyReadContext,
  accountId: string,
  fn: (providerAccountRef: string) => Promise<T>,
) => Promise<T>;

const KIND = "read_company";
const companyUrlOf = linkedinPort.methods.getCompany.input.shape.companyUrl;
let opener: RefOpener | undefined;

/** The worker's decrypt entry, registered by workflows/index.ts as the worker loads it. */
export function useRefOpener(next: RefOpener | undefined): void {
  opener = next;
}

/** The decrypt entry the worker registered, for this module's other reads (domain/contact/). */
export const refOpener = (): RefOpener | undefined => opener;

/**
 * The page's facts through the workspace's account with the most company reads left now, its window
 * open; another account when that one's reservation is refused meanwhile. read_input_invalid naming
 * `companyUrl` for a link that is no company page; a port error other than linkedin_not_found is
 * thrown, after its row and its health, as every read's.
 */
export async function readCompany(
  input: { readonly companyUrl: string },
  context: CompanyReadContext,
): Promise<CompanyRead> {
  const open = opener;
  if (open === undefined) throw new AppError(errors.company_read_unavailable);
  const page = companyUrlOf.safeParse(input.companyUrl);
  if (!page.success) {
    throw new AppError(errors.read_input_invalid, { details: { fields: ["companyUrl"] } });
  }
  const { connected, readers } = await context.tenant(candidates);
  if (connected === 0) return { status: "no_account" };
  for (const accountId of readers) {
    const reserved = await context.tenant(async () => {
      const answer = await reserveReads({ accountId, count: 1, kind: KIND });
      return "reservationId" in answer ? answer.reservationId : null;
    });
    if (reserved === null) continue;
    return read(open, context, accountId, reserved, page.data);
  }
  return { status: "no_reads_left" };
}

/** The connected accounts' count, and those that may read a page now, the most reads left first. */
async function candidates(): Promise<{ connected: number; readers: string[] }> {
  const accounts = (await listAccounts()).filter((account) => account.status === "connected");
  const left: [string, number][] = [];
  for (const account of accounts) {
    const reads = await readsLeftToday(account.id);
    if (!reads.windowOpen || reads.left === 0) continue;
    const share = await companyReadsLeft(account.id, await dayOf(account, now(), false));
    if (share > 0) left.push([account.id, Math.min(reads.left, share)]);
  }
  const readers = left.toSorted((a, b) => b[1] - a[1]).map(([id]) => id);
  return { connected: accounts.length, readers };
}

/** The call on the reserved read, its row, and the read committed, or released without a call. */
async function read(
  open: RefOpener,
  context: CompanyReadContext,
  accountId: SenderAccount["id"],
  reservationId: string,
  companyUrl: string,
): Promise<CompanyRead> {
  const adapter = await linkedin();
  let called = false;
  try {
    const company = await open(context, accountId, (providerAccountRef) => {
      called = true;
      return adapter.getCompany({ providerAccountRef, companyUrl });
    });
    await settle(context, accountId, reservationId, "ok");
    return { status: "read", company };
  } catch (error) {
    if (!called) {
      await context.tenant(() => releaseReads(reservationId));
      throw error;
    }
    await settle(context, accountId, reservationId, outcomeOf(error), error);
    if (outcomeOf(error) === linkedinPort.errors.linkedin_not_found) return { status: "not_found" };
    throw error;
  }
}

/** The call's row, a port error's health, and the read committed, in one run; then the metric. */
async function settle(
  context: CompanyReadContext,
  accountId: string,
  reservationId: string,
  outcome: ActionOutcome,
  error?: unknown,
): Promise<void> {
  const logged = await context.tenant(async () => {
    const row = await logAction({ accountId, kind: KIND, count: 1, outcome });
    if (error !== undefined) await afterPortError(accountId, error, now());
    await commitReads(reservationId, 1);
    return row;
  });
  countAction(logged);
}
