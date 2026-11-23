// The counts route's answer (README.md "Routes"), from which the api host builds the OpenAPI document
// and the web its client: each sender account of the workspace's enrollments with its label and zone,
// and its numbers today, over the last 7 days and since the start, the days in its zone. Ids, labels,
// zones and numbers only: no person, no message text, no provider reference.
import { z } from "zod";

const count = z.int().min(0);

/** One period's numbers (domain/counts.ts). */
const tally = z.strictObject({
  /** Connection requests sent: `invite` steps `succeeded`, by `executed_at`. */
  invitesSent: count,
  /** Messages sent: `message` steps `succeeded`, by `executed_at`. */
  messagesSent: count,
  /** Invitations accepted: `invite` steps with `accepted_at`, the detection time, by it. */
  accepted: count,
  /** People who replied: enrollments `replied`, by `ended_at`. */
  replied: count,
});

export const countsResponse = z.strictObject({
  /** When the counts were read: today is this instant's local day in each account's zone. */
  asOf: z.iso.datetime(),
  /** Whose accounts: `own`, the caller's; `all`, every member's, for a holder of linkedin.manage. */
  scope: z.enum(["own", "all"]),
  /** By label; an account linkedin no longer holds last. Empty without an enrollment. */
  senders: z.array(
    z.strictObject({
      senderAccountId: z.string(),
      /** The account's label; null once linkedin no longer holds the account. */
      label: z.string().nullable(),
      /** The account's IANA zone, which its days follow; null as the label, the days then UTC's. */
      timeZone: z.string().nullable(),
      /** From the start of the account's local day. */
      today: tally,
      /** From the start of the local day six days before today: today and the six days before it. */
      last7Days: tally,
      sinceStart: tally,
    }),
  ),
});
export type CountsResponse = z.infer<typeof countsResponse>;
