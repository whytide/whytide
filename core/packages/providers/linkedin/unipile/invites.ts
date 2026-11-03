// The invitations on Unipile (README.md "Covers"): a connection request, its note sent only when it
// has text (RB-11.2.5: none by default); its withdrawal; the account's pending invitations a page at
// a time under a signed cursor (cursor.ts) of the account's; and a member's relation, read from the
// profile without notifying the member. Unipile takes no idempotency key, so the port's is dropped:
// the one-send guarantee is the caller's (README.md "Known differences").
import { z } from "zod";
import type { PortImplementation } from "../../_pattern/index.ts";
import type { linkedinPort } from "../port.ts";
import { type Client, offShape, segment } from "./client.ts";
import { INVITES_PAGE, PENDING_INVITATION, RELATION } from "./constants.ts";
import { type Cursors, cursorInvalid } from "./cursor.ts";

type Methods = Pick<
  PortImplementation<typeof linkedinPort>,
  "sendInvite" | "withdrawInvite" | "listPendingInvites" | "getRelation"
>;

const ref = z.string().min(1).max(256);
const sent = z.object({ invitation_id: ref });
const list = z.object({ items: z.array(z.unknown()), cursor: z.string().min(1).nullish() });
const invitation = z.object({
  id: ref,
  invited_user_id: ref,
  parsed_datetime: z.string().nullish(),
});
const relation = z.object({
  network_distance: z.string().nullish(),
  invitation: z.object({ type: z.string(), status: z.string() }).nullish(),
});
/** A pending-invitations cursor's state: the account's, and Unipile's cursor of the next page. */
const page = z.strictObject({ account: z.string(), vendor: z.string().min(1) });

export function invites(call: Client, now: () => number, cursors: Cursors): Methods {
  return {
    sendInvite: async ({ providerAccountRef, memberRef, note }) => {
      const message = note?.trim() ? { message: note } : {};
      const body = { account_id: providerAccountRef, provider_id: memberRef, ...message };
      const answer = sent.safeParse(await call("sendInvite", { path: "/users/invite", body }));
      if (!answer.success) throw offShape("sendInvite");
      return { invitationRef: answer.data.invitation_id, sentAt: new Date(now()) };
    },
    withdrawInvite: async ({ providerAccountRef, invitationRef }) => {
      const path = `/users/invite/sent/${segment(invitationRef, "withdrawInvite")}`;
      const query = { account_id: providerAccountRef };
      await call("withdrawInvite", { path, query, verb: "DELETE" });
      return { withdrawnAt: new Date(now()) };
    },
    listPendingInvites: async ({ providerAccountRef, cursor }) => {
      const method = "listPendingInvites";
      const vendor =
        cursor === undefined ? undefined : resumed(cursors, cursor, providerAccountRef);
      const query = {
        account_id: providerAccountRef,
        limit: String(INVITES_PAGE),
        ...(vendor === undefined ? {} : { cursor: vendor }),
      };
      const answer = list.safeParse(await call(method, { path: "/users/invite/sent", query }));
      if (!answer.success) throw offShape(method);
      const listedAt = now();
      const next = answer.data.cursor;
      return {
        invites: answer.data.items.flatMap((item) => pendingOf(item, listedAt)),
        nextCursor: next
          ? cursors.sign(method, { account: providerAccountRef, vendor: next })
          : null,
      };
    },
    getRelation: async ({ providerAccountRef, memberRef }) => {
      // The member's provider_id, getProfile's providerMemberRef; notify=false: no profile view.
      const path = `/users/${segment(memberRef, "getRelation")}`;
      const query = { account_id: providerAccountRef, notify: "false" };
      const answer = relation.safeParse(await call("getRelation", { path, query }));
      if (!answer.success) throw offShape("getRelation");
      const { network_distance: distance, invitation: pending } = answer.data;
      return {
        connected: distance === RELATION,
        invitationPending:
          pending?.type === PENDING_INVITATION.type && pending.status === PENDING_INVITATION.status,
      };
    },
  };
}

/** The vendor's cursor of a cursor signed for this method, of this account: else input_invalid. */
function resumed(cursors: Cursors, cursor: string, account: string): string {
  const state = page.safeParse(cursors.open("listPendingInvites", cursor));
  if (state.success && state.data.account === account) return state.data.vendor;
  throw cursorInvalid("listPendingInvites", "account");
}

/**
 * A pending invitation in the port's words; none for one without its id or its member's, which the
 * port cannot hold. Its time is Unipile's `parsed_datetime`, else the listing's.
 */
function pendingOf(item: unknown, listedAt: number) {
  const parsed = invitation.safeParse(item);
  if (!parsed.success) return [];
  const { id, invited_user_id: memberRef, parsed_datetime: datetime } = parsed.data;
  const at = Date.parse(datetime ?? "");
  return [{ invitationRef: id, memberRef, sentAt: new Date(Number.isNaN(at) ? listedAt : at) }];
}
