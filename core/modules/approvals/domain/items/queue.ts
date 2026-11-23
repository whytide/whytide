// The queue as "Up next" reads it (README.md "Routes"; docs/flows.md ""Up next" loads"), in the
// request's tenant run, for the principal alone, whatever their role (gamma-p6-050): the senders of
// the items it could show or count, each read once, the LinkedIn account (linkedin's
// findSenderAccount) or an email's mailbox (email's findMailbox, gamma-p4-090), and the principal's
// own connected account (linkedin's senderOf); of those, the ones the principal owns; then those
// senders' pending items and approved ones that wait, by due time, at most ITEMS_LIST_MAX. Another
// member's items are never read into the answer, so they never take a place in it. Each item comes
// with its channel, its lead (contacts' getLead), its draft (messaging's stepDrafts, none while it is
// being written), its sender, whether the caller decides it, and its flags, computed now and never
// stored. The counts are per sender, today's decisions counted in the sender's own zone; the totals
// are their sums.
import { errors as contactsErrors, getLead, type Tier, type WhyBullet } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { senderOf as connectedAccountOf } from "@whytide/linkedin";
import { type StepDraft, stepDrafts } from "@whytide/messaging";
import { isAppError, type Principal } from "@whytide/platform";
import { now as queueNow } from "./clock.ts";
import {
  type Channel,
  DECISION_ORIGIN,
  DECISIONS,
  ITEMS_LIST_MAX,
  LOCAL_DAY_MAX_HOURS,
  MS_PER_HOUR,
} from "./constants.ts";
import { compare, countTodayBySender, isStale, needsAttention } from "./rules.ts";
import {
  channelOf,
  type Item,
  itemColumns,
  owns,
  type Sender,
  type SenderRef,
  senderIdOf,
  sendersOf,
  sentFrom,
  zoneOf,
} from "./store.ts";

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
  /** LinkedIn's, or an email's. */
  readonly channel: Channel;
  /** The step's local day, in the sender's zone, is before today there. */
  readonly stale: boolean;
  /** Pending APPROVALS_NEEDS_ATTENTION_AFTER_DAYS days or more (settings.ts). */
  readonly needsAttention: boolean;
  /** Null once contacts no longer has the lead. */
  readonly lead: QueueLead | null;
  /** Null while the draft is being written. */
  readonly draft: StepDraft | null;
  /** Null once the account or the mailbox is gone; an email's has no account, its label the address. */
  readonly sender: {
    readonly accountId: string | null;
    readonly label: string;
    readonly timeZone: string;
  } | null;
  /** The caller owns the sender, the account or the mailbox, so may approve or skip. */
  readonly canDecide: boolean;
};
/** One of the principal's senders, an account or an email's mailbox, with its counts. */
export type QueueSender = {
  /** The account's id; null for a mailbox. */
  readonly accountId: string | null;
  /** The mailbox's id; null for an account. */
  readonly mailboxId: string | null;
  /** The account's label, or the mailbox's address. */
  readonly label: string;
  readonly timeZone: string;
  /** Its pending items, past ITEMS_LIST_MAX too. */
  readonly toApprove: number;
  /** Its items a person approved or skipped since the start of today in its own zone. */
  readonly decidedToday: number;
};
export type Queue = {
  readonly items: readonly QueueItem[];
  /** By label. */
  readonly senders: readonly QueueSender[];
  /** The senders' sums. */
  readonly counts: { readonly toApprove: number; readonly decidedToday: number };
};

const PENDING = { status: "pending" as const };
const WAITING = { status: "approved" as const, waitCode: { not: null } };
/** The queue of a principal with no sender. */
const EMPTY: Queue = { items: [], senders: [], counts: { toApprove: 0, decidedToday: 0 } };

/**
 * The principal's queue: the items of their own senders, and each sender's counts of pending items
 * (`toApprove`) and of items a person approved or skipped since the start of today in that sender's
 * zone (`decidedToday`), the mode's approvals left out; the totals are the senders' sums. A
 * principal who owns no sender, nor holds a connected account, has an empty queue and no sender.
 */
export async function readQueue(principal: Principal, now: Date = queueNow()): Promise<Queue> {
  // A local day lasts LOCAL_DAY_MAX_HOURS at most: today's decisions, in any zone, are newer.
  const recent = new Date(now.getTime() - LOCAL_DAY_MAX_HOURS * MS_PER_HOUR);
  const decidedRecently = {
    status: { in: [...DECISIONS] },
    decisionOrigin: DECISION_ORIGIN,
    decidedAt: { gte: recent },
  };
  // Each sender the queue could show or count, once, with its items' count per status.
  const groups = await tenantClient.approvalItem.groupBy({
    by: ["senderAccountId", "mailboxId", "status"],
    where: { OR: [PENDING, WAITING, decidedRecently] },
    _count: { _all: true },
  });
  const account = await connectedAccountOf(principal.userId);
  const connected: SenderRef[] = account ? [{ senderAccountId: account.id, mailboxId: null }] : [];
  const senders = await sendersOf([...groups, ...connected]);
  const mine = [...senders.values()].filter((sender) => owns(sender, principal.userId));
  if (mine.length === 0) return EMPTY;
  const own = sentFrom(mine);
  const rows = await tenantClient.approvalItem.findMany({
    where: { AND: [own, { OR: [PENDING, WAITING] }] },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    take: ITEMS_LIST_MAX,
    select: itemColumns,
  });
  const decided = await tenantClient.approvalItem.findMany({
    where: { AND: [own, decidedRecently] },
    select: { senderAccountId: true, mailboxId: true, decidedAt: true },
  });
  const today = countTodayBySender(
    decided.map((row) => ({ senderAccountId: senderIdOf(row), decidedAt: row.decidedAt })),
    now,
    (senderId) => zoneOf(senders.get(senderId)),
  );
  const toApprove = new Map<string, number>();
  for (const group of groups) {
    if (group.status !== PENDING.status) continue;
    const senderId = senderIdOf(group);
    toApprove.set(senderId, (toApprove.get(senderId) ?? 0) + group._count._all);
  }
  const counted = mine.map((sender) => countsOf(sender, toApprove, today)).sort(byLabel);
  const items = await describe(rows, principal, now, senders);
  const sum = (count: (sender: QueueSender) => number) =>
    counted.reduce((total, sender) => total + count(sender), 0);
  const counts = { toApprove: sum((s) => s.toApprove), decidedToday: sum((s) => s.decidedToday) };
  return { items, senders: counted, counts };
}

/** The sender as the answer names it, with its counts. */
function countsOf(
  sender: Sender,
  toApprove: ReadonlyMap<string, number>,
  today: ReadonlyMap<string, number>,
): QueueSender {
  const { id, channel, label, timeZone } = sender;
  const ids = {
    accountId: channel === "linkedin" ? id : null,
    mailboxId: channel === "email" ? id : null,
  };
  return {
    ...ids,
    label,
    timeZone,
    toApprove: toApprove.get(id) ?? 0,
    decidedToday: today.get(id) ?? 0,
  };
}

/** By label, then by id, by code unit whatever the locale. */
const byLabel = (a: QueueSender, b: QueueSender): number =>
  compare(a.label, b.label) ||
  compare(a.accountId ?? a.mailboxId ?? "", b.accountId ?? b.mailboxId ?? "");

/** One item as the queue shows it, for the decision routes' answers. */
export async function describeItem(item: Item, principal: Principal): Promise<QueueItem> {
  const senders = await sendersOf([item]);
  return (await describe([item], principal, queueNow(), senders))[0] as QueueItem;
}

/** The items as the queue shows them: their drafts in one read, each lead once. */
async function describe(
  rows: readonly Item[],
  principal: Principal,
  now: Date,
  senders: ReadonlyMap<string, Sender | null>,
): Promise<QueueItem[]> {
  const draftIds = rows.flatMap(({ draftId }) => (draftId === null ? [] : [draftId]));
  const drafts = new Map((await stepDrafts(draftIds)).map((draft) => [draft.id, draft]));
  const leads = new Map<string, QueueLead | null>();
  for (const { personId } of rows) {
    if (!leads.has(personId)) leads.set(personId, await leadOf(personId));
  }
  return rows.map((row) => {
    const sender = senders.get(senderIdOf(row)) ?? null;
    const { senderAccountId: accountId } = row;
    return {
      ...row,
      channel: channelOf(row),
      stale: isStale(row.scheduledFor, now, zoneOf(sender)),
      needsAttention: row.status === "pending" && needsAttention(row.createdAt, now),
      lead: leads.get(row.personId) ?? null,
      draft: row.draftId === null ? null : (drafts.get(row.draftId) ?? null),
      sender: sender && { accountId, label: sender.label, timeZone: sender.timeZone },
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
