// The invite mail (README.md "Invites"): one mail through the app-mail port once the invite's run has
// committed, outside any run, as the tenant commands' mail (cli/tenant-admin.ts); POST /invites and
// `pnpm invite` send it. identity.mail.invite, in defaultLocale(), the invitee having no locale yet:
// the workspace, the inviter, the role, the day the invite expires, the address to sign in with and
// the Invitations page. Never a token or a link that signs in: the invitee signs in with the address,
// which proves it. While APP_PUBLIC_ORIGIN is empty the invite stays made and no mail goes, a path
// alone being no use in a mail. A failed send keeps the invite: inviting again sends again.
import { AppError, defaultLocale, formatDate, isAppError, renderMail } from "@whytide/platform";
import { appMailConfig, appMailPort, getAdapter } from "@whytide/providers";
import { findUser, findWorkspace, errors as tenancyErrors } from "@whytide/tenancy";
import { now } from "./clock.ts";
import { INVITATIONS_PATH, MAIL_DATE_FORMAT, MAIL_NAME_MAX, ORIGIN_VARIABLE } from "./constants.ts";
import type { Invite } from "./invites.ts";
import { inWorkspace } from "./store.ts";

/** What became of the mail: sent, skipped (no origin), or failed with the port's code. */
export type MailOutcome =
  | { readonly mail: "sent" | "skipped" }
  | { readonly mail: "failed"; readonly mailCode: string };
/** The outcome, and the invite's mailed_at after it: the new one once a mail went. */
export type MailResult = MailOutcome & { readonly mailedAt: Date | null };

/** Whitespace and control characters, a line break among them: one space in a mail's line. */
const BREAKS = /[\s\p{Cc}]+/gu;
/** The characters that reorder text: a name could make the mail read otherwise. */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/gu;

/** The web app's origin, without its trailing slashes; empty when unset. */
export function appOrigin(): string {
  return (process.env[ORIGIN_VARIABLE] ?? "").trim().replace(/\/+$/, "");
}

/** A name on one line, without bidi controls, MAIL_NAME_MAX characters at most. */
export function oneLine(name: string): string {
  const line = name.replace(BIDI_CONTROLS, "").replace(BREAKS, " ").trim();
  return [...line].slice(0, MAIL_NAME_MAX).join("").trim();
}

/**
 * The mail of the invite, outside any run: skipped while APP_PUBLIC_ORIGIN is empty; sent, then
 * mailed_at set in a run of the invite's workspace; failed with the port's code, the invite kept.
 */
export async function mailInvite(invite: Invite): Promise<MailResult> {
  const { mailedAt } = invite;
  const origin = appOrigin();
  if (origin === "") return { mail: "skipped", mailedAt };
  try {
    const params = await paramsOf(invite, `${origin}${INVITATIONS_PATH}`);
    const { subject, body } = renderMail("identity.mail.invite", params, defaultLocale());
    const mail = await getAdapter(appMailPort, appMailConfig.PROVIDER_APP_MAIL);
    await mail.send({ to: invite.email, subject, text: body });
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { mail: "failed", mailCode: error.code, mailedAt };
  }
  const sent = now();
  await inWorkspace(invite.workspaceId, (tx) =>
    tx.invite.updateMany({ where: { id: invite.id }, data: { mailedAt: sent } }),
  );
  return { mail: "sent", mailedAt: sent };
}

/** The mail's values: names on one line, the expiry as a day in UTC. */
async function paramsOf(invite: Invite, url: string) {
  const workspace = await findWorkspace(invite.workspaceId);
  if (workspace === null) throw new AppError(tenancyErrors.workspace_not_found);
  const user = invite.invitedBy === null ? null : await findUser(invite.invitedBy);
  // The inviter's display name, or their email when they have none.
  const inviter = user === null ? "" : oneLine(user.displayName ?? "") || oneLine(user.email);
  const locale = defaultLocale();
  return {
    workspace: oneLine(workspace.name),
    hasInviter: inviter !== "",
    inviter,
    role: invite.role,
    expires: formatDate(invite.expiresAt, locale, MAIL_DATE_FORMAT),
    email: invite.email,
    url,
  };
}
