// The receiver's filter (README.md "The webhook", docs/security.md): a person event is kept only when
// it concerns a person the account invited or messaged, an outreach row of that account. An
// acceptance matches on the member; a message on its chat, or on the member: the sender of an inbound
// message, an attendee of one the account sent. The lookup reads refs only, in the account's
// workspace, and says nothing about an event it drops.
import type { TenantClient } from "@whytide/db";
import type { InviteAccepted, MessageReceived } from "@whytide/providers";

/** The events about a person: the receiver's, the account events aside. */
export type PersonEvent = InviteAccepted | MessageReceived;
/** An outreach row as the filter reads it: its person and the refs it matches on. */
export type Outreach = {
  readonly id: string;
  readonly personId: string;
  readonly providerMemberRef: string | null;
  readonly providerChatRef: string | null;
};
type Match = (row: Outreach) => boolean;

/**
 * The tests a row passes for the event, in the order they win: the member for an acceptance; for an
 * inbound message its sender, who wrote it, then its chat; for the account's own message its chat,
 * where it was written, then its attendees in their order.
 */
function matchesOf(event: PersonEvent): Match[] {
  const member =
    (ref: string): Match =>
    (row) =>
      row.providerMemberRef === ref;
  if (event.kind === "invite.accepted") return [member(event.memberRef)];
  const chat: Match = (row) => row.providerChatRef === event.chatRef;
  if (!event.fromAccount) return [member(event.senderMemberRef), chat];
  return [chat, ...event.attendeeMemberRefs.map(member)];
}

/** The row the event concerns among the account's candidates, the first test's first, else null. */
export function pick(event: PersonEvent, rows: readonly Outreach[]): Outreach | null {
  for (const match of matchesOf(event)) {
    const row = rows.find(match);
    if (row !== undefined) return row;
  }
  return null;
}

/** The refs the event names its person by: the members, and the chat of a message. */
function refsOf(event: PersonEvent): { memberRefs: string[]; chatRefs: string[] } {
  if (event.kind === "invite.accepted") return { memberRefs: [event.memberRef], chatRefs: [] };
  const memberRefs = event.fromAccount ? [...event.attendeeMemberRefs] : [event.senderMemberRef];
  return { memberRefs, chatRefs: [event.chatRef] };
}

/** The outreach row of the account the event concerns, among the rows its refs name, or null. */
export async function findOutreach(
  tx: TenantClient,
  accountId: string,
  event: PersonEvent,
): Promise<Outreach | null> {
  const { memberRefs, chatRefs } = refsOf(event);
  const rows = await tx.senderOutreach.findMany({
    where: {
      senderAccountId: accountId,
      OR: [{ providerMemberRef: { in: memberRefs } }, { providerChatRef: { in: chatRefs } }],
    },
    select: { id: true, personId: true, providerMemberRef: true, providerChatRef: true },
    orderBy: { id: "asc" },
  });
  return pick(event, rows);
}
