// The counts page's numbers (README.md "Routes"; docs/concepts.md "Counts"), in the caller's tenant
// run: for each sender account the workspace's enrollments name, the connection requests and the
// messages sent, the invitations accepted and the people who replied, today, over the last 7 days and
// since the start, the days in the account's own zone. Each measure is one query over campaigns' own
// rows, grouped by sender, with each sender's period starts: a send is a `succeeded` invite or
// message by its `executed_at`, an acceptance an invite's `accepted_at` (the detection, beta-p4-050),
// a reply an enrollment `replied` by its `ended_at`. The label and the zone are linkedin's
// (findSenderAccount): null for an account it no longer holds, whose days are UTC's. Ids, labels,
// zones and numbers only: no person, no text, no provider reference.
import { Prisma, tenantClient } from "@whytide/db";
import { findSenderAccount, errors as linkedinErrors } from "@whytide/linkedin";
import { currentTenant, instantAt, isAppError, quotaDay } from "@whytide/platform";
import {
  COUNTS_FALLBACK_ZONE,
  DATE_LENGTH,
  LOCAL_DAY_START,
  MS_PER_DAY,
  RECENT_DAYS,
} from "./constants.ts";

/** One period's numbers. */
export type Tally = {
  readonly invitesSent: number;
  readonly messagesSent: number;
  readonly accepted: number;
  readonly replied: number;
};
type Measure = keyof Tally;
type Period = "today" | "last7Days" | "sinceStart";

/** A sender account's numbers by period, with its label and zone: null once linkedin no longer holds it. */
export type SenderCounts = {
  readonly senderAccountId: string;
  readonly label: string | null;
  readonly timeZone: string | null;
} & Readonly<Record<Period, Tally>>;

/** Where a sender's periods start: today's local midnight, and the one six days before it. */
export type PeriodStarts = { readonly today: Date; readonly last7Days: Date };

/** The starts of the periods at `at` in the zone, from platform's quota day: pure. */
export function periodStarts(at: Date, timeZone: string): PeriodStarts {
  const today = quotaDay(at, timeZone);
  return {
    today: instantAt(today, LOCAL_DAY_START, timeZone),
    last7Days: instantAt(dateBefore(today, RECENT_DAYS - 1), LOCAL_DAY_START, timeZone),
  };
}

/** The date `days` calendar days before `date`, both `YYYY-MM-DD`. */
function dateBefore(date: string, days: number): string {
  const day = new Date(Date.parse(`${date}T00:00:00Z`) - days * MS_PER_DAY);
  return day.toISOString().slice(0, DATE_LENGTH);
}

/**
 * Each measure's rows in the workspace, as the sender's settle, the acceptance and the hold leave
 * them: the sender account and the instant the periods read. A withdrawal, a failed, skipped or
 * unsent step and an enrollment that did not end on a reply are in none.
 */
const SOURCES: Readonly<Record<Measure, (workspaceId: string) => Prisma.Sql>> = {
  invitesSent: (workspaceId) => Prisma.sql`
    SELECT sender_account_id, executed_at AS at FROM step_executions
    WHERE workspace_id = ${workspaceId} AND action_type = 'invite' AND status = 'succeeded'`,
  messagesSent: (workspaceId) => Prisma.sql`
    SELECT sender_account_id, executed_at AS at FROM step_executions
    WHERE workspace_id = ${workspaceId} AND action_type = 'message' AND status = 'succeeded'`,
  accepted: (workspaceId) => Prisma.sql`
    SELECT sender_account_id, accepted_at AS at FROM step_executions
    WHERE workspace_id = ${workspaceId} AND action_type = 'invite' AND accepted_at IS NOT NULL`,
  replied: (workspaceId) => Prisma.sql`
    SELECT sender_account_id, ended_at AS at FROM enrollments
    WHERE workspace_id = ${workspaceId} AND status = 'replied'`,
};

type Sender = {
  readonly senderAccountId: string;
  readonly label: string | null;
  readonly timeZone: string | null;
  readonly starts: PeriodStarts;
};
type Counted = Readonly<Record<Period, number>> & { readonly senderAccountId: string };

/**
 * The numbers at `at` of each sender account the workspace's enrollments name, ordered by label,
 * an account linkedin no longer holds last; none without an enrollment that has one.
 */
export async function countsBySender(at: Date): Promise<SenderCounts[]> {
  const senders = await sendersOf(at);
  if (senders.length === 0) return [];
  const starts = Prisma.join(
    senders.map(
      ({ senderAccountId, starts }) =>
        Prisma.sql`(${senderAccountId}::text, ${starts.today}::timestamptz, ${starts.last7Days}::timestamptz)`,
    ),
  );
  const { workspaceId } = currentTenant();
  const counts = new Map(senders.map(({ senderAccountId }) => [senderAccountId, zeros()]));
  for (const measure of MEASURES) {
    for (const row of await countBySender(SOURCES[measure](workspaceId), starts)) {
      const sender = counts.get(row.senderAccountId);
      if (sender === undefined) continue;
      for (const period of PERIODS) sender[period][measure] = row[period];
    }
  }
  return senders.map(({ senderAccountId, label, timeZone }) => ({
    ...{ senderAccountId, label, timeZone },
    ...(counts.get(senderAccountId) ?? zeros()),
  }));
}

const MEASURES = Object.keys(SOURCES) as Measure[];
const PERIODS = ["today", "last7Days", "sinceStart"] as const satisfies readonly Period[];

function zeros(): Record<Period, Record<Measure, number>> {
  const tally = () => ({ invitesSent: 0, messagesSent: 0, accepted: 0, replied: 0 });
  return { today: tally(), last7Days: tally(), sinceStart: tally() };
}

/** A measure's numbers per sender in one query: its rows joined to each sender's period starts. */
function countBySender(source: Prisma.Sql, starts: Prisma.Sql): Promise<Counted[]> {
  return tenantClient.$queryRaw<Counted[]>`
    WITH starts (sender_account_id, today, last_7_days) AS (VALUES ${starts})
    SELECT starts.sender_account_id AS "senderAccountId",
      (COUNT(*) FILTER (WHERE measured.at >= starts.today))::int AS "today",
      (COUNT(*) FILTER (WHERE measured.at >= starts.last_7_days))::int AS "last7Days",
      COUNT(*)::int AS "sinceStart"
    FROM (${source}) AS measured
    JOIN starts ON starts.sender_account_id = measured.sender_account_id
    GROUP BY starts.sender_account_id`;
}

/** The sender accounts of the workspace's enrollments, each with its periods' starts, by label. */
async function sendersOf(at: Date): Promise<Sender[]> {
  const rows = await tenantClient.enrollment.groupBy({
    by: ["senderAccountId"],
    where: { senderAccountId: { not: null } },
  });
  const senders: Sender[] = [];
  for (const { senderAccountId } of rows) {
    if (senderAccountId === null) continue;
    const account = await accountOf(senderAccountId);
    const timeZone = account?.timeZone ?? null;
    const starts = periodStarts(at, timeZone ?? COUNTS_FALLBACK_ZONE);
    senders.push({ senderAccountId, label: account?.label ?? null, timeZone, starts });
  }
  return senders.sort(byLabel);
}

/** The account's label and zone; null when linkedin no longer holds it in the run's workspace. */
async function accountOf(id: string): Promise<{ label: string; timeZone: string } | null> {
  try {
    const { label, timeZone } = await findSenderAccount(id);
    return { label, timeZone };
  } catch (error) {
    if (isAppError(error) && error.code === linkedinErrors.sender_account_not_found) return null;
    throw error;
  }
}

/** By label in code-unit order, an account linkedin no longer holds last; then by id. */
function byLabel(a: Sender, b: Sender): number {
  if (a.label !== b.label) {
    if (a.label === null) return 1;
    if (b.label === null) return -1;
    return a.label < b.label ? -1 : 1;
  }
  return a.senderAccountId < b.senderAccountId ? -1 : a.senderAccountId > b.senderAccountId ? 1 : 0;
}
