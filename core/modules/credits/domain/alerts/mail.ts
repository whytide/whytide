// The alert's mail (README "Alerts"; docs/flows.md "The credit alerts"), credits_mail_alert's work,
// global, as linkedin's health mail goes: the alert read with its organization's current period and
// balance; an alert mailed already answers already_sent, one of a past period past_period, and
// neither sends. The recipients through tenancy: the organization's workspaces (listWorkspaceIds,
// findWorkspace), in each one's run its active members (listMembers), every Owner and Admin, each
// user once, a disabled one skipped (findUser). Each is mailed through the app-mail port in their own
// locale, never inside a run, with the link to the costs page of their first workspace while
// APP_PUBLIC_ORIGIN is set, once per alert across attempts and checks (review-gaps-2): a recipient
// recorded for the alert (credit_alert_mails) is skipped, and one is recorded right after their send.
// One failing send leaves the others to go, then fails the attempt; once every recipient is recorded,
// notified_at is set on the alert and on the lower rows of its organization and period not mailed
// yet, which go with this mail. A mail that failed its attempts, whatever ended them, raises the
// tries of those rows through failAlert, which credits_alerts calls, so the next check tries again
// until CREDIT_ALERT_MAX_TRIES. The mail names the organization and the figures, never a person, a
// lead or a workspace; the log lines hold ids and counts.
import {
  formatDate,
  formatNumber,
  type Logger,
  renderMail,
  resolveLocale,
} from "@whytide/platform";
import { appMailConfig, appMailPort, getAdapter } from "@whytide/providers";
import {
  findOrganization,
  findUser,
  findWorkspace,
  listMembers,
  listWorkspaceIds,
} from "@whytide/tenancy";
import { inGlobal, inWorkspace } from "../store.ts";
import {
  ALERT_MAIL_LOCK,
  ALERT_SEND_HOLD_MS,
  CREDIT_ALERT_ROLES,
  CREDITS_PATH,
  MAIL_AMOUNT_FORMAT,
  MAIL_DATE_FORMAT,
  ORIGIN_VARIABLE,
  WORKSPACE_PATH,
} from "./constants.ts";

export type AlertMailResult =
  | { readonly sent: true; readonly recipients: number }
  | {
      readonly sent: false;
      /** no_recipient: the organization has no Owner or Admin to mail; the alert counts as mailed. */
      readonly reason: "alert_not_found" | "already_sent" | "past_period" | "no_recipient";
    };

/** The alert with its organization's current period and balance, the amounts as decimal strings. */
type Alert = {
  readonly organizationId: string;
  readonly periodStart: Date;
  readonly threshold: number;
  readonly used: string;
  readonly granted: string;
  readonly notifiedAt: Date | null;
  readonly currentStart: Date | null;
  readonly periodEnd: Date | null;
  readonly left: string;
};
type Recipient = {
  /** tenancy's user: the record's key. */
  readonly userId: string;
  readonly email: string;
  readonly locale: string | null;
  /** The first of the organization's workspaces where they are Owner or Admin: the link's. */
  readonly workspaceId: string;
};

/**
 * The Owners' mail of the alert `alertId`, each recipient once across attempts and checks; the first
 * failed send's error once the others went. already_sent also when another mail of the alert, at the
 * same time, marked it first.
 */
export async function mailAlert(
  alertId: string,
  { log }: { readonly log: Logger },
): Promise<AlertMailResult> {
  const alert = await readAlert(alertId);
  if (alert === undefined) return { sent: false, reason: "alert_not_found" };
  if (alert.notifiedAt !== null) return { sent: false, reason: "already_sent" };
  const { organizationId, threshold, periodEnd } = alert;
  if (periodEnd === null || alert.currentStart?.getTime() !== alert.periodStart.getTime()) {
    return { sent: false, reason: "past_period" };
  }
  const fields = { alert_id: alertId, organization_id: organizationId, threshold };
  const recipients = await recipientsOf(organizationId);
  if (recipients.length > 0) {
    const name = (await findOrganization(organizationId))?.name ?? "";
    const mail = await getAdapter(appMailPort, appMailConfig.PROVIDER_APP_MAIL);
    let failure: { readonly error: unknown } | undefined;
    for (const recipient of recipients) {
      const { subject, body } = render({ ...alert, periodEnd }, name, recipient);
      const send = () => mail.send({ to: recipient.email, subject, text: body });
      await mailOnce(alertId, recipient.userId, send).catch((error: unknown) => {
        failure ??= { error };
      });
    }
    if (failure !== undefined) throw failure.error;
  }
  const { count } = await markRows(alert, { notifiedAt: new Date() });
  if (recipients.length === 0) {
    log.warn(fields, "credits: an alert has no Owner to mail");
    return { sent: false, reason: "no_recipient" };
  }
  if (count === 0) return { sent: false, reason: "already_sent" };
  log.info({ ...fields, recipient_count: recipients.length }, "credits: an alert is mailed");
  return { sent: true, recipients: recipients.length };
}

/**
 * The tries of the alert's rows raised once, its own and the lower ones not mailed yet: its mail
 * failed its attempts, whatever ended them, a timeout included (credits_alerts calls it then). The
 * rows' count; none for an alert mailed already or not found.
 */
export async function failAlert(
  alertId: string,
  { log }: { readonly log: Logger },
): Promise<number> {
  const alert = await readAlert(alertId);
  if (alert === undefined || alert.notifiedAt !== null) return 0;
  const { count } = await markRows(alert, { tries: { increment: 1 } });
  const { organizationId: organization_id, threshold } = alert;
  const fields = { alert_id: alertId, organization_id, threshold, row_count: count };
  log.warn(fields, "credits: an alert's mail failed its attempts");
  return count;
}

/**
 * One recipient's send, unless recorded for the alert, then their record, in a transaction of its
 * own under a lock of the alert and the user held for that send only: another mail of the alert at
 * the same time waits, then finds the record. The record commits right after the send; when it fails
 * after the send, the next attempt mails that recipient again, the one way anyone gets two.
 */
function mailOnce(alertId: string, userId: string, send: () => Promise<unknown>) {
  const key = `${ALERT_MAIL_LOCK}:${alertId}:${userId}`;
  return inGlobal("alerts", (_db, app) =>
    app.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        const where = { alertId_userId: { alertId, userId } };
        if ((await tx.creditAlertMail.findUnique({ where })) !== null) return;
        await send();
        await tx.creditAlertMail.create({ data: { alertId, userId } });
      },
      { timeout: ALERT_SEND_HOLD_MS },
    ),
  );
}

/** The alert, its organization's subscription period and its balance with carry-over, one read. */
function readAlert(alertId: string): Promise<Alert | undefined> {
  return inGlobal("alerts", async (_db, app) => {
    const [row] = await app.$queryRaw<Alert[]>`
      SELECT a.organization_id AS "organizationId", a.period_start AS "periodStart", a.threshold,
        trim_scale(a.used)::text AS used, trim_scale(a.granted)::text AS granted,
        a.notified_at AS "notifiedAt", s.period_start AS "currentStart",
        s.period_end AS "periodEnd",
        trim_scale(COALESCE(b.granted - b.reserved - b.committed, 0))::text AS "left"
      FROM credit_alerts a
        LEFT JOIN subscriptions s ON s.organization_id = a.organization_id
        LEFT JOIN credit_balances b ON b.organization_id = a.organization_id
      WHERE a.id = ${alertId}`;
    return row;
  });
}

/** The rows of the alert's mail, its own and the lower ones not mailed yet, changed as `data` says. */
function markRows(
  alert: Alert,
  data: { readonly notifiedAt: Date } | { readonly tries: { readonly increment: 1 } },
) {
  const { organizationId, periodStart, threshold } = alert;
  const where = { organizationId, periodStart, threshold: { lte: threshold }, notifiedAt: null };
  return inGlobal("alerts", (db) => db.creditAlert.updateMany({ where, data }));
}

/** The organization's active Owners and Admins, each user once, a disabled one left out. */
async function recipientsOf(organizationId: string): Promise<Recipient[]> {
  const workspaceIds: string[] = [];
  for (const id of await listWorkspaceIds()) {
    if ((await findWorkspace(id))?.organizationId === organizationId) workspaceIds.push(id);
  }
  const workspaceOf = new Map<string, string>();
  for (const workspaceId of workspaceIds) {
    for (const { userId, role } of await inWorkspace(workspaceId, () => listMembers())) {
      if (CREDIT_ALERT_ROLES.includes(role) && !workspaceOf.has(userId)) {
        workspaceOf.set(userId, workspaceId);
      }
    }
  }
  const recipients: Recipient[] = [];
  for (const [userId, workspaceId] of workspaceOf) {
    const user = await findUser(userId);
    if (user === null || user.disabledAt !== null) continue;
    recipients.push({ userId, email: user.email, locale: user.locale, workspaceId });
  }
  return recipients;
}

/** The mail in the recipient's locale: the organization's name, the figures and the period's end. */
function render(alert: Alert & { readonly periodEnd: Date }, name: string, recipient: Recipient) {
  const locale = resolveLocale(recipient.locale);
  const amount = (value: string) => formatNumber(Number(value), locale, MAIL_AMOUNT_FORMAT);
  const link = linkOf(recipient.workspaceId);
  const params = {
    organization: name,
    threshold: alert.threshold,
    used: amount(alert.used),
    granted: amount(alert.granted),
    left: amount(alert.left),
    periodEnd: formatDate(alert.periodEnd, locale, MAIL_DATE_FORMAT),
    link,
    hasLink: link !== "",
  };
  return renderMail("credits.mail.alert", params, locale);
}

/** The workspace's costs page on the web app, or "" while APP_PUBLIC_ORIGIN is empty. */
function linkOf(workspaceId: string): string {
  const origin = (process.env[ORIGIN_VARIABLE] ?? "").trim().replace(/\/+$/, "");
  if (origin === "") return "";
  return `${origin}${WORKSPACE_PATH}/${encodeURIComponent(workspaceId)}/${CREDITS_PATH}`;
}
