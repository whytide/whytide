// The health mails (README.md "Health"; docs/security.md "The health mail"), linkedin_mail_health's
// work. The owner's, about a health event: a run reads the event and the account's owner, and an
// event mailed already answers already_sent; tenancy's findUser outside any run, and a missing or
// disabled owner answers owner_unavailable; the mail rendered in the owner's locale and sent through
// the app-mail port, never inside a run; then a run sets owner_notified_at where it is still null.
// The workflow's id stops a second delivery of the event, the marker a retry once the mail went (C38).
// The mail says what happened, what stops, until when and what to do, with the link to the LinkedIn
// page while APP_PUBLIC_ORIGIN is set: never a person's data, the account's reference or a provider's
// message. The operator's, about the fleet breaker's trip (breaker.ts), the same way to
// LINKEDIN_ALERT_EMAIL, in the instance's default locale, its marker operator_notified_at: the ids,
// the trigger, the time and the reopen command, never the account's label or reference either.
import type { TenantClient } from "@whytide/db";
import { defaultLocale, formatDate, renderMail, resolveLocale } from "@whytide/platform";
import { appMailConfig, appMailPort, getAdapter } from "@whytide/providers";
import { findUser } from "@whytide/tenancy";
import { linkedinConfig } from "../../config.ts";
import { now } from "../clock.ts";
import { MAIL_DATE_FORMAT, OPERATOR_MAIL_DATE_FORMAT } from "./constants.ts";

export type HealthMailResult =
  | { readonly sent: true }
  | {
      readonly sent: false;
      /** no_address: the operator's mail while LINKEDIN_ALERT_EMAIL is empty. */
      readonly reason: "already_sent" | "owner_unavailable" | "event_not_found" | "no_address";
    };
type Run = <T>(fn: (tx: TenantClient) => Promise<T>) => Promise<T>;
let fixedAddress: string | null | undefined;

/** For tests (testing/): an address in place of LINKEDIN_ALERT_EMAIL; null: none set. */
export function useAlertEmail(address: string | null | undefined): void {
  fixedAddress = address;
}

/** The mail of the event `healthEventId` to the account's owner, at most once. */
export async function mailHealthEvent(
  run: Run,
  workspaceId: string,
  healthEventId: string,
): Promise<HealthMailResult> {
  const found = await run(async (tx) => {
    const event = await tx.senderHealthEvent.findFirst({ where: { id: healthEventId } });
    if (event === null) return null;
    const account = await tx.senderAccount.findFirst({
      where: { id: event.senderId },
      select: { ownerUserId: true, timeZone: true },
    });
    return account === null ? null : { event, account };
  });
  if (found === null) return { sent: false, reason: "event_not_found" };
  const { event, account } = found;
  if (event.ownerNotifiedAt !== null) return { sent: false, reason: "already_sent" };
  const owner = await findUser(account.ownerUserId);
  if (owner === null || owner.disabledAt !== null) {
    return { sent: false, reason: "owner_unavailable" };
  }
  const locale = resolveLocale(owner.locale);
  const until = event.pausedUntil;
  const pausedUntil =
    until === null
      ? ""
      : `${formatDate(until, locale, { ...MAIL_DATE_FORMAT, timeZone: account.timeZone })} (${account.timeZone})`;
  const link = linkOf(workspaceId);
  const params = {
    trigger: event.trigger,
    pausedUntil,
    link,
    hasLink: link !== "",
  };
  const { subject, body } = renderMail("linkedin.mail.account_paused", params, locale);
  const mail = await getAdapter(appMailPort, appMailConfig.PROVIDER_APP_MAIL);
  await mail.send({ to: owner.email, subject, text: body });
  await run((tx) =>
    tx.senderHealthEvent.updateMany({
      where: { id: healthEventId, ownerNotifiedAt: null },
      data: { ownerNotifiedAt: now() },
    }),
  );
  return { sent: true };
}

/**
 * The operator's mail about the fleet breaker's trip, whose health event is `healthEventId`, at most
 * once: no_address while LINKEDIN_ALERT_EMAIL is empty, before any read.
 */
export async function mailOperator(
  run: Run,
  workspaceId: string,
  healthEventId: string,
): Promise<HealthMailResult> {
  const to = alertEmail();
  if (to === undefined) return { sent: false, reason: "no_address" };
  const event = await run((tx) =>
    tx.senderHealthEvent.findFirst({
      where: { id: healthEventId },
      select: { senderId: true, trigger: true, createdAt: true, operatorNotifiedAt: true },
    }),
  );
  if (event === null) return { sent: false, reason: "event_not_found" };
  if (event.operatorNotifiedAt !== null) return { sent: false, reason: "already_sent" };
  const locale = defaultLocale();
  const params = {
    trigger: event.trigger,
    workspaceId,
    accountId: event.senderId,
    at: formatDate(event.createdAt, locale, OPERATOR_MAIL_DATE_FORMAT),
  };
  const { subject, body } = renderMail("linkedin.mail.invites_paused", params, locale);
  const mail = await getAdapter(appMailPort, appMailConfig.PROVIDER_APP_MAIL);
  await mail.send({ to, subject, text: body });
  await run((tx) =>
    tx.senderHealthEvent.updateMany({
      where: { id: healthEventId, operatorNotifiedAt: null },
      data: { operatorNotifiedAt: now() },
    }),
  );
  return { sent: true };
}

/** The operator's address, or undefined while LINKEDIN_ALERT_EMAIL is empty. */
function alertEmail(): string | undefined {
  return fixedAddress === undefined
    ? linkedinConfig.LINKEDIN_ALERT_EMAIL
    : (fixedAddress ?? undefined);
}

/** The workspace's LinkedIn page on the web app, or "" while APP_PUBLIC_ORIGIN is empty. */
function linkOf(workspaceId: string): string {
  const origin = (process.env.APP_PUBLIC_ORIGIN ?? "").replace(/\/+$/, "");
  return origin === "" ? "" : `${origin}/w/${encodeURIComponent(workspaceId)}/linkedin`;
}
