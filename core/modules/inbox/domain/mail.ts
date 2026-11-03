// The reply mail (README.md "The reply mail"; docs/flows.md): one mail per reply to the sender
// account's owner, who it was addressed to, saying who replied, with a link to the thread, never the
// reply's text. The activity inbox_mail_reply runs it: the message, its thread and the person's first
// name in one tenant run; the owner from tenancy's users, outside any run; the mail through the
// app-mail port; then the sent marker, owner_notified_at, in a second run. The port takes no
// idempotency key, so a crash between the send and the marker can send a second mail.
import { errors as contactsErrors, getPerson } from "@whytide/contacts";
import { type TenantClient, tenantClient } from "@whytide/db";
import {
  type ActivityContext,
  createLogger,
  isAppError,
  renderMail,
  resolveLocale,
} from "@whytide/platform";
import { appMailConfig, appMailPort, getAdapter } from "@whytide/providers";
import { findUser } from "@whytide/tenancy";
import { INBOX_PATH, MAIL_NAME_MAX, ORIGIN_VARIABLE, WORKSPACE_PATH } from "./constants.ts";

/**
 * Why a reply got no mail: it went already, the owner is no user who can sign in, or the message,
 * its thread or its person is gone (erased since the event).
 */
export type MailSkip = "already_sent" | "owner_unavailable" | "gone";
/** What the activity answers: never an address, a name or a text. */
export type MailResult =
  | { readonly sent: true }
  | { readonly sent: false; readonly reason: MailSkip };

/** The reply as the mail reads it: the thread, its owner and the person's first name. */
type Reply = {
  readonly threadId: string;
  readonly ownerUserId: string;
  readonly firstName: string | null;
};

/** Line breaks, tabs and other controls, which a one-line subject cannot hold. */
const BREAKS = /[\s\p{Cc}]+/gu;
/** The marks that turn the direction of the text after them, which could disguise the subject. */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

let log: ReturnType<typeof createLogger> | undefined;

/**
 * The mail of one reply, in the activity's context: its runs are `context.tenant`'s; the rest runs
 * outside any run, as a provider call must. Each skip answers with its reason and sends nothing.
 */
export async function mailReply(
  context: Pick<ActivityContext<TenantClient>, "workspaceId" | "tenant">,
  messageId: string,
): Promise<MailResult> {
  const reply = await context.tenant(() => readReply(messageId));
  if (typeof reply === "string") return { sent: false, reason: reply };
  // Outside any run: tenancy reads the global users table, which no tenant run may.
  const owner = await findUser(reply.ownerUserId);
  if (owner === null || owner.disabledAt !== null) {
    const fields = { message_id: messageId, thread_id: reply.threadId, user_id: reply.ownerUserId };
    (log ??= createLogger()).info(
      { ...fields, outcome: "owner_unavailable" },
      "inbox: no reply mail, the owner is unavailable",
    );
    return { sent: false, reason: "owner_unavailable" };
  }
  const link = threadLink(context.workspaceId, reply.threadId);
  const firstName = mailName(reply.firstName);
  const params = {
    ...{ firstName: firstName ?? "", hasName: firstName !== null },
    ...{ link, hasLink: link !== "" },
  };
  const { subject, body } = renderMail("inbox.mail.reply", params, resolveLocale(owner.locale));
  const mail = await getAdapter(appMailPort, appMailConfig.PROVIDER_APP_MAIL);
  await mail.send({ to: owner.email, subject, text: body });
  await context.tenant(() => markNotified(messageId, new Date()));
  return { sent: true };
}

/**
 * The first name as a mail carries it, its breaks and controls one space and its direction marks
 * dropped; null for none, or one longer than MAIL_NAME_MAX, which no first name is.
 */
export function mailName(firstName: string | null): string | null {
  const name = (firstName ?? "").replace(BIDI_CONTROLS, "").replace(BREAKS, " ").trim();
  return name === "" || [...name].length > MAIL_NAME_MAX ? null : name;
}

/** The thread's page in the web app; empty while the app's origin is, as a path alone is no use in a mail. */
function threadLink(workspaceId: string, threadId: string): string {
  const origin = (process.env[ORIGIN_VARIABLE] ?? "").trim().replace(/\/+$/, "");
  if (origin === "") return "";
  const workspace = `${WORKSPACE_PATH}/${encodeURIComponent(workspaceId)}`;
  return `${origin}${workspace}/${INBOX_PATH}/${encodeURIComponent(threadId)}`;
}

/** The inbound message's thread and person, or why no mail goes: the marker set, or a row gone. */
async function readReply(messageId: string): Promise<Reply | "already_sent" | "gone"> {
  const message = await tenantClient.message.findFirst({
    where: { id: messageId, direction: "in" },
    select: { threadId: true, ownerNotifiedAt: true },
  });
  if (message === null) return "gone";
  if (message.ownerNotifiedAt !== null) return "already_sent";
  const thread = await tenantClient.thread.findFirst({
    where: { id: message.threadId },
    select: { id: true, ownerUserId: true, personId: true },
  });
  if (thread === null) return "gone";
  try {
    const { firstName } = await getPerson(thread.personId);
    return { threadId: thread.id, ownerUserId: thread.ownerUserId, firstName };
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_not_found) return "gone";
    throw error;
  }
}

/** The sent marker, where it is still unset: a retry after it finds the mail sent. */
async function markNotified(messageId: string, now: Date): Promise<void> {
  await tenantClient.message.updateMany({
    where: { id: messageId, ownerNotifiedAt: null },
    data: { ownerNotifiedAt: now },
  });
}
