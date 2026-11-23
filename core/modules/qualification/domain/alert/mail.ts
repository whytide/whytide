// The Hot alert's mail (README "The Hot alert"; docs/flows.md; docs/security.md "The Hot mail"),
// the activity qualification_mail_hot_lead, once the subscriber claimed the alert. A tenant run reads
// the person's row, still Hot, and its why-now signal's part: the signal's kind, role, date and the
// member who created its source. Outside any run, as tenancy's reads and a provider call must be:
// that member's membership of the workspace, a member who left getting nothing, then the user, a
// disabled one or none getting nothing either; the mail rendered in the member's locale and sent
// through the app-mail port. It says what the signal was and how long ago, with the link to the
// lead's page while APP_PUBLIC_ORIGIN is set: never the person's name, headline, company, words or
// URL. The claim stays set whatever the outcome, and the activity has one attempt: a failed send is
// not retried, so nobody gets two mails. One log line per alert, with ids and the outcome only.
import { type TenantClient, tenantClient } from "@whytide/db";
import { type ActivityContext, type Logger, renderMail, resolveLocale } from "@whytide/platform";
import { appMailConfig, appMailPort, getAdapter } from "@whytide/providers";
import { findUser, resolveMembership } from "@whytide/tenancy";
import { DAY_MS, HOT_TIER } from "../intent/constants.ts";
import { type ReadPart, readParts } from "../intent/store.ts";
import { LEADS_PATH, ORIGIN_VARIABLE, WORKSPACE_PATH } from "./constants.ts";

/**
 * Why a claimed alert sent no mail: the lead left Hot or lost its row since the claim, the row names
 * no dated why-now signal, its source's creator is unknown (a deleted source), or that member left
 * the workspace, or is no user who can sign in.
 */
export type HotAlertSkip =
  | "not_hot"
  | "no_signal"
  | "owner_unknown"
  | "member_left"
  | "owner_unavailable";
/** What the activity answers: never an address, a name or a text. */
export type HotAlertResult =
  | { readonly sent: true }
  | { readonly sent: false; readonly reason: HotAlertSkip };

/** The why-now signal as the mail reads it. */
type Signal = Pick<ReadPart, "kind" | "role"> & {
  readonly at: string;
  readonly ownerUserId: string;
};
type Context = Pick<ActivityContext<TenantClient>, "workspaceId" | "tenant">;

let log: Logger | undefined;

/** The logger of the alert's line: the worker host's (workflows/index.ts onWorkerStart), a test's. */
export function useAlertLog(logger: Logger | undefined): void {
  log = logger;
}

/** The mail of the person's entry into Hot, the signal's age as of `now`. */
export async function mailHotLead(
  context: Context,
  personId: string,
  now = new Date(),
): Promise<HotAlertResult> {
  const signal = await context.tenant(() => whyNowOf(personId));
  const result: HotAlertResult =
    typeof signal === "string"
      ? { sent: false, reason: signal }
      : await mailTo(context.workspaceId, personId, signal, now);
  const user = typeof signal === "string" ? {} : { user_id: signal.ownerUserId };
  const outcome = result.sent ? "sent" : result.reason;
  log?.info({ person_id: personId, ...user, outcome }, "qualification: the Hot alert");
  return result;
}

/** The row's why-now signal, or why no mail goes. */
async function whyNowOf(
  personId: string,
): Promise<Signal | "not_hot" | "no_signal" | "owner_unknown"> {
  const row = await tenantClient.intentScore.findFirst({
    where: { personId },
    select: { tier: true, whyNowEventId: true, intentBreakdown: true },
  });
  if (row === null || row.tier !== HOT_TIER) return "not_hot";
  const part = readParts(row.intentBreakdown).find(({ eventId }) => eventId === row.whyNowEventId);
  if (part === undefined || part.at === null) return "no_signal";
  if (part.ownerUserId === null) return "owner_unknown";
  return { kind: part.kind, role: part.role, at: part.at, ownerUserId: part.ownerUserId };
}

/** The mail to the signal's owner while they are a member of the workspace and can sign in. */
async function mailTo(
  workspaceId: string,
  personId: string,
  signal: Signal,
  now: Date,
): Promise<HotAlertResult> {
  const userId = signal.ownerUserId;
  const member = await resolveMembership({ userId, workspaceIdOrSlug: workspaceId });
  if (member === null) return { sent: false, reason: "member_left" };
  const user = await findUser(userId);
  if (user === null || user.disabledAt !== null)
    return { sent: false, reason: "owner_unavailable" };
  const link = leadLink(workspaceId, personId);
  const days = Math.max(0, Math.floor((now.getTime() - Date.parse(signal.at)) / DAY_MS));
  const params = { kind: signal.kind, role: signal.role, days, link, hasLink: link !== "" };
  const locale = resolveLocale(user.locale);
  const { subject, body } = renderMail("qualification.mail.hot_lead", params, locale);
  const mail = await getAdapter(appMailPort, appMailConfig.PROVIDER_APP_MAIL);
  await mail.send({ to: user.email, subject, text: body });
  return { sent: true };
}

/** The lead's page in the web app; empty while the app's origin is, as a path alone is no use in a mail. */
function leadLink(workspaceId: string, personId: string): string {
  const origin = (process.env[ORIGIN_VARIABLE] ?? "").trim().replace(/\/+$/, "");
  if (origin === "") return "";
  const workspace = `${WORKSPACE_PATH}/${encodeURIComponent(workspaceId)}`;
  return `${origin}${workspace}/${LEADS_PATH}/${encodeURIComponent(personId)}`;
}
