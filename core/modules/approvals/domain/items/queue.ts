// The queue as "Up next" reads it (README.md "Routes"; docs/flows.md "The queue read"), in the
// request's tenant run: every pending item, overdue ones included, and every approved one whose step
// waits, by due time, at most ITEMS_LIST_MAX. Each item comes with its lead (contacts' getLead), its
// draft (messaging's stepDrafts, none while it is being written), its sender account (linkedin's
// findSenderAccount), whether the caller decides it, and its flags, computed now and never stored.
import { errors as contactsErrors, getLead, type Tier, type WhyBullet } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import type { SenderAccount } from "@whytide/linkedin";
import { type StepDraft, stepDrafts } from "@whytide/messaging";
import { isAppError, type Principal } from "@whytide/platform";
import { DECISIONS, ITEMS_LIST_MAX, LOCAL_DAY_MAX_HOURS, MS_PER_HOUR } from "./constants.ts";
import { countToday, isStale, needsAttention } from "./rules.ts";
import { type Item, itemColumns, owns, sendersOf, zoneOf } from "./store.ts";

/** The lead an item reaches, as the leads list shows one: its first why bullet only. */
export type QueueLead = {
  readonly personId: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly title: string | null;
  readonly companyName: string | null;
  readonly tier: Tier | null;
  readonly why: WhyBullet | null;
};
/** An item as the queue shows it. */
export type QueueItem = Item & {
  /** The step's local day, in the sender's zone, is before today there. */
  readonly stale: boolean;
  /** Pending NEEDS_ATTENTION_AFTER_DAYS days or more. */
  readonly needsAttention: boolean;
  /** Null once contacts no longer has the lead. */
  readonly lead: QueueLead | null;
  /** Null while the draft is being written. */
  readonly draft: StepDraft | null;
  /** Null once linkedin no longer has the account. */
  readonly sender: {
    readonly accountId: string;
    readonly label: string;
    readonly timeZone: string;
  } | null;
  /** The caller owns the sender account, so may approve or skip. */
  readonly canDecide: boolean;
};
export type Queue = {
  readonly items: readonly QueueItem[];
  readonly counts: { readonly toApprove: number; readonly decidedToday: number };
};

/**
 * The queue for the principal: the items, and the counts of pending items (`toApprove`, all of
 * them, past ITEMS_LIST_MAX too) and of items approved or skipped since the start of today in their
 * sender's zone (`decidedToday`).
 */
export async function readQueue(principal: Principal, now: Date = new Date()): Promise<Queue> {
  const waiting = { status: "approved" as const, waitCode: { not: null } };
  const rows = await tenantClient.approvalItem.findMany({
    where: { OR: [{ status: "pending" as const }, waiting] },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    take: ITEMS_LIST_MAX,
    select: itemColumns,
  });
  const toApprove = await tenantClient.approvalItem.count({ where: { status: "pending" } });
  // A local day lasts LOCAL_DAY_MAX_HOURS at most: today's decisions, in any zone, are newer.
  const recent = new Date(now.getTime() - LOCAL_DAY_MAX_HOURS * MS_PER_HOUR);
  const decided = await tenantClient.approvalItem.findMany({
    where: { status: { in: [...DECISIONS] }, decidedAt: { gte: recent } },
    select: { senderAccountId: true, decidedAt: true },
  });
  const senders = await sendersOf([...rows, ...decided].map((row) => row.senderAccountId));
  const items = await describe(rows, principal, now, senders);
  const decidedToday = countToday(decided, now, (account) => zoneOf(senders.get(account)));
  return { items, counts: { toApprove, decidedToday } };
}

/** One item as the queue shows it, for the decision routes' answers. */
export async function describeItem(item: Item, principal: Principal): Promise<QueueItem> {
  const senders = await sendersOf([item.senderAccountId]);
  return (await describe([item], principal, new Date(), senders))[0] as QueueItem;
}

/** The items as the queue shows them: their drafts in one read, each lead once. */
async function describe(
  rows: readonly Item[],
  principal: Principal,
  now: Date,
  senders: ReadonlyMap<string, SenderAccount | null>,
): Promise<QueueItem[]> {
  const draftIds = rows.flatMap(({ draftId }) => (draftId === null ? [] : [draftId]));
  const drafts = new Map((await stepDrafts(draftIds)).map((draft) => [draft.id, draft]));
  const leads = new Map<string, QueueLead | null>();
  for (const { personId } of rows) {
    if (!leads.has(personId)) leads.set(personId, await leadOf(personId));
  }
  return rows.map((row) => {
    const sender = senders.get(row.senderAccountId) ?? null;
    return {
      ...row,
      stale: isStale(row.scheduledFor, now, zoneOf(sender)),
      needsAttention: row.status === "pending" && needsAttention(row.createdAt, now),
      lead: leads.get(row.personId) ?? null,
      draft: row.draftId === null ? null : (drafts.get(row.draftId) ?? null),
      sender: sender && { accountId: sender.id, label: sender.label, timeZone: sender.timeZone },
      canDecide: owns(sender, principal.userId),
    };
  });
}

const GONE: readonly string[] = [contactsErrors.lead_not_found, contactsErrors.person_not_found];

/** The person's lead as the queue shows it, or null once contacts has no lead or person of the id. */
async function leadOf(personId: string): Promise<QueueLead | null> {
  try {
    const { person, tier, why } = await getLead(personId);
    const { firstName, lastName, title, companyName } = person;
    return { personId, firstName, lastName, title, companyName, tier, why: why[0] ?? null };
  } catch (error) {
    if (isAppError(error) && GONE.includes(error.code)) return null;
    throw error;
  }
}
