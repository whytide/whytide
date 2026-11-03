// What `pnpm tenant:create` and `pnpm workspace:create` share (README.md "The tenant commands"):
// the admin's options and user, a refusal's line, and the one mail to the admin. The mail goes once
// the rows are committed, never inside a run (core/packages/db README "One run at a time"), and it
// names the sign-in page, never a link that signs in.
import { defaultLocale, isAppError, renderMail } from "@whytide/platform";
import { appMailConfig, appMailPort, getAdapter } from "@whytide/providers";
import { findUserByEmail, type User, upsertUser } from "@whytide/tenancy";
import { normalizeEmail } from "../domain/rules.ts";
import { EXIT, SIGN_IN_PATH } from "./constants.ts";

export type Print = (line: string) => void;
export type Admin = {
  readonly email: string;
  readonly displayName?: string;
  readonly mail: boolean;
};

/** The options both commands take, for parseArgs. */
export const ADMIN_OPTIONS = {
  "admin-email": { type: "string" },
  "admin-name": { type: "string" },
  "no-mail": { type: "boolean" },
} as const;

/** The admin the options name, the email as stored; null when it is missing or not an email. */
export function adminOf(values: {
  "admin-email"?: string;
  "admin-name"?: string;
  "no-mail"?: boolean;
}): Admin | null {
  const email = normalizeEmail(values["admin-email"]);
  if (email === null) return null;
  return { email, displayName: values["admin-name"], mail: values["no-mail"] !== true };
}

/**
 * The admin's user, made when there is none, `--admin-name` its display name. A disabled user could
 * not sign in: null then, and the line, before anything is made.
 */
export async function adminUser(admin: Admin, print: Print): Promise<User | null> {
  const found = await findUserByEmail(admin.email);
  if (found?.disabledAt) {
    print(`user_disabled: ${admin.email} could not sign in; nothing was made`);
    return null;
  }
  return upsertUser({ email: admin.email, displayName: admin.displayName });
}

/**
 * A refusal, a code under 500, as its line with the fields at fault or `subject`: exit 1. Anything
 * else is thrown, as `pnpm invite` does.
 */
export function refused(error: unknown, subject: string, print: Print): number {
  if (!isAppError(error) || error.status >= 500) throw error;
  const fields = error.details?.fields;
  print(`${error.code}: ${Array.isArray(fields) ? fields.join(", ") : subject}`);
  return EXIT.refused;
}

/**
 * The mail to the admin, unless --no-mail, then the sign-in page's line. One mail through the
 * app-mail port, identity.mail.admin_added: the workspace, the organization, the sign-in page and
 * the address to sign in with. None while APP_PUBLIC_ORIGIN is empty: a path alone is no use in a
 * mail. A failed mail prints the port's code, `made` saying what is made all the same: exit 3.
 */
export async function mailAdmin(
  admin: Admin,
  names: { readonly workspace: string; readonly organization: string },
  made: string,
  print: Print,
): Promise<number> {
  // APP_PUBLIC_ORIGIN, the api's variable, is the web app's origin.
  const origin = (process.env.APP_PUBLIC_ORIGIN ?? "").replace(/\/+$/, "");
  const url = `${origin}${SIGN_IN_PATH}`;
  let exit: number = EXIT.done;
  if (!admin.mail) {
    print("mail_skipped: --no-mail");
  } else if (origin === "") {
    print("mail_skipped: APP_PUBLIC_ORIGIN is empty, and a path alone is no use in a mail");
  } else {
    try {
      const params = { ...names, url, email: admin.email };
      const { subject, body } = renderMail("identity.mail.admin_added", params, defaultLocale());
      const mail = await getAdapter(appMailPort, appMailConfig.PROVIDER_APP_MAIL);
      await mail.send({ to: admin.email, subject, text: body });
      print(`mail_sent: ${admin.email}`);
    } catch (error) {
      if (!isAppError(error)) throw error;
      print(`${error.code}: no mail went to ${admin.email}; ${made} made`);
      exit = EXIT.mailFailed;
    }
  }
  print(`sign_in_page: ${url}`);
  return exit;
}
