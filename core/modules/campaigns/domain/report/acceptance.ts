// acceptance_rate (README.md "Commands"; beta's "Done when": connection acceptance at least 25%
// overall), in the caller's tenant run: of the connection requests whose step `succeeded` in the
// period and no later than `sentBefore`, the share whose acceptance was detected (accepted_at). The
// command sets `sentBefore` a week before the run, linkedin's acceptance rule, so fresh invites do not
// pull the rate down.
import { tenantClient } from "@whytide/db";

/** A sender's connection requests counted, and those accepted. */
export type SenderAcceptance = {
  readonly senderAccountId: string;
  readonly sent: number;
  readonly accepted: number;
};

/** Each sender's counts, by sender id (the file's header). */
export async function acceptanceBySender(period: {
  readonly since: Date;
  readonly sentBefore: Date;
}): Promise<SenderAcceptance[]> {
  const steps = await tenantClient.stepExecution.findMany({
    where: {
      actionType: "invite",
      status: "succeeded",
      executedAt: { gte: period.since, lte: period.sentBefore },
    },
    select: { senderAccountId: true, acceptedAt: true },
  });
  const bySender = new Map<string, { sent: number; accepted: number }>();
  for (const { senderAccountId, acceptedAt } of steps) {
    const counts = bySender.get(senderAccountId) ?? { sent: 0, accepted: 0 };
    counts.sent += 1;
    if (acceptedAt !== null) counts.accepted += 1;
    bySender.set(senderAccountId, counts);
  }
  return [...bySender]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([senderAccountId, counts]) => ({ senderAccountId, ...counts }));
}

/** accepted / sent; null when nothing was sent. */
export const acceptanceShare = ({ sent, accepted }: { sent: number; accepted: number }) =>
  sent === 0 ? null : accepted / sent;
