// A reply label's notice (README.md "Reply actions"; docs/flows.md "A reply's label"): one mail to
// the user campaigns.reply_notice_due names, sent by the activity campaigns_reply_notice_mail (kind
// provider) through the app-mail port, as inbox's reply mail is. interested links the reply's thread
// in the inbox, not_now (the reminder) the lead's page. The mail carries the person's first name
// only, on one line and MAIL_NAME_MAX characters at most, else "a lead", and never the reply's text.
// The first name is read in a tenant run; the user and their membership in tenancy, outside any run:
// one who is no user, is disabled or is no longer a member of the workspace gets none, the ids
// logged. The port takes no idempotency key, so an attempt that fails after its send can mail twice;
// a redelivered event starts no second run (events.ts). The reminder's mail names
// CAMPAIGNS_NOT_NOW_REMINDER_DAYS as configured (settings.ts).
import { errors as contactsErrors, getPerson } from "@whytide/contacts";
import type { TenantClient } from "@whytide/db";
import {
  type ActivityContext,
  createLogger,
  isAppError,
  type Logger,
  renderMail,
  resolveLocale,
} from "@whytide/platform";
import { appMailConfig, appMailPort, getAdapter } from "@whytide/providers";
import { findUser, resolveMembership } from "@whytide/tenancy";
import { settings } from "../../settings.ts";
import {
  INBOX_PATH,
  LEADS_PATH,
  MAIL_NAME_MAX,
  ORIGIN_VARIABLE,
  type ReplyNoticeKind,
  WORKSPACE_PATH,
} from "./constants.ts";

/** campaigns.reply_notice_due as the activity takes it: ids and the kind. */
export type Notice = {
  readonly enrollmentId: string;
  readonly personId: string;
  readonly kind: ReplyNoticeKind;
  readonly threadId: string | null;
  readonly ownerUserId: string;
};
/** Why no mail went: the user cannot be mailed in the workspace, or the person is gone (erased). */
export type NoticeSkip = "owner_unavailable" | "gone";
/** What the activity answers: never an address, a name or a text. */
export type NoticeResult =
  | { readonly sent: true }
  | { readonly sent: false; readonly reason: NoticeSkip };

/** Line breaks, tabs and other controls, which a one-line subject cannot hold. */
const BREAKS = /[\s\p{Cc}]+/gu;
/** The marks that turn the direction of the text after them, which could disguise the subject. */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/gu;

let log: Logger | undefined;

/** The notice's mail, in the activity's context (the file's header); each skip sends nothing. */
export async function mailNotice(
  context: Pick<ActivityContext<TenantClient>, "workspaceId" | "tenant">,
  notice: Notice,
): Promise<NoticeResult> {
  const { workspaceId } = context;
  const fields = {
    enrollment_id: notice.enrollmentId,
    person_id: notice.personId,
    user_id: notice.ownerUserId,
    kind: notice.kind,
  };
  const person = await context.tenant(() => personOf(notice.personId));
  if (person === null) {
    (log ??= createLogger()).info({ ...fields, outcome: "gone" }, "campaigns: no reply notice");
    return { sent: false, reason: "gone" };
  }
  // Outside any run: tenancy reads the global users and memberships, which no tenant run may.
  const owner = await findUser(notice.ownerUserId);
  const member =
    owner === null || owner.disabledAt !== null
      ? null
      : await resolveMembership({ userId: owner.id, workspaceIdOrSlug: workspaceId });
  if (owner === null || member === null) {
    (log ??= createLogger()).info(
      { ...fields, outcome: "owner_unavailable" },
      "campaigns: no reply notice, the owner is unavailable",
    );
    return { sent: false, reason: "owner_unavailable" };
  }
  const name = mailName(person.firstName);
  const link = linkOf(workspaceId, notice);
  const params = { firstName: name ?? "", hasName: name !== null, link, hasLink: link !== "" };
  const locale = resolveLocale(owner.locale);
  const days = settings.CAMPAIGNS_NOT_NOW_REMINDER_DAYS;
  // One literal key per mail: the message check reads the calls.
  const { subject, body } =
    notice.kind === "interested"
      ? renderMail("campaigns.mail.interested", params, locale)
      : renderMail("campaigns.mail.not_now", { ...params, days }, locale);
  const mail = await getAdapter(appMailPort, appMailConfig.PROVIDER_APP_MAIL);
  await mail.send({ to: owner.email, subject, text: body });
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

/** The thread's page (interested) or the lead's (not_now); empty while the app's origin is. */
function linkOf(workspaceId: string, notice: Notice): string {
  const origin = (process.env[ORIGIN_VARIABLE] ?? "").trim().replace(/\/+$/, "");
  if (origin === "") return "";
  const workspace = `${origin}${WORKSPACE_PATH}/${encodeURIComponent(workspaceId)}`;
  if (notice.kind === "not_now") {
    return `${workspace}/${LEADS_PATH}/${encodeURIComponent(notice.personId)}`;
  }
  return notice.threadId === null
    ? ""
    : `${workspace}/${INBOX_PATH}/${encodeURIComponent(notice.threadId)}`;
}

/** The person's first name; null once the person is erased. */
async function personOf(personId: string): Promise<{ firstName: string | null } | null> {
  try {
    const { firstName } = await getPerson(personId);
    return { firstName };
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_not_found) return null;
    throw error;
  }
}
