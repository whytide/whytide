// `pnpm invite <email> [--workspace <id or slug>] [--no-mail]` (README.md "The invite command"): an
// engineer invites an email to a workspace, WORKSPACE_SLUG by default, as Owner, and the invite mail
// goes to it as from the Invites screen (domain/mail.ts); the line gives the sign-in page, never a
// link that signs in. A second run for an email with an open invite, or a member's, reports it and
// exits 0. On a database with no organization, the default workspace is made first, the email its
// Owner. Each line starts with a code: organization_created, invite_created, invite_exists,
// already_member, mail_sent, mail_skipped, mail_failed, or the refusal's.
import { parseArgs } from "node:util";
import { isAppError } from "@whytide/platform";
import { findWorkspaceBySlug, settings } from "@whytide/tenancy";
import { bootstrapFirstWorkspace, createInvite, type Invite } from "../domain/invites.ts";
import { appOrigin, mailInvite } from "../domain/mail.ts";
import { normalizeEmail } from "../domain/rules.ts";
import { errors } from "../errors.ts";
import { EXIT, SIGN_IN_PATH } from "./constants.ts";

const USAGE = "usage: pnpm invite <email> [--workspace <id or slug>] [--no-mail]";
/** The refusals that leave the email able to sign in: a second run is harmless. */
const ANSWERED: readonly string[] = [errors.invite_exists, errors.already_member];

/**
 * The command with its arguments; the exit code: 0 invited, 1 refused, 2 a usage error, 3 the
 * invite made and its mail failed.
 */
export async function runInvite(args: string[], print: (line: string) => void): Promise<number> {
  const parsed = parse(args);
  if (parsed === null) {
    print(USAGE);
    return EXIT.usage;
  }
  const { email, named, chosen, mail } = parsed;
  // APP_PUBLIC_ORIGIN, the api's variable, is the web app's origin; unset, the path alone.
  const signIn = `${appOrigin()}${SIGN_IN_PATH}`;
  // An id has an underscore and a slug none (tenancy's docs/concepts.md).
  let workspaceId: string | undefined = named;
  try {
    if (!named.includes("_")) workspaceId = (await findWorkspaceBySlug(named))?.id;
    const made = workspaceId === undefined && !chosen ? await bootstrapFirstWorkspace(email) : null;
    if (made) {
      workspaceId = made.id;
      print(
        `organization_created: ${made.name}, workspace ${made.slug} (${made.id}), Owner ${email}`,
      );
    }
    if (workspaceId === undefined) {
      print(`workspace_not_found: no single workspace has the slug ${named}: pass its id`);
      return EXIT.refused;
    }
    const invite = await createInvite({ workspaceId, email, role: "Owner", invitedBy: null });
    print(`invite_created: ${email} may sign in to ${workspaceId} at ${signIn}`);
    return mail ? await mailed(invite, print) : skipped("--no-mail", print);
  } catch (error) {
    if (!isAppError(error) || error.status >= 500) throw error;
    if (!ANSWERED.includes(error.code)) {
      print(`${error.code}: ${named}`);
      return EXIT.refused;
    }
    const already = error.code === errors.invite_exists ? "is invited to" : "is a member of";
    print(`${error.code}: ${email} ${already} ${workspaceId} already; sign-in page ${signIn}`);
    return EXIT.done;
  }
}

/** The invite mail's line: sent, skipped while APP_PUBLIC_ORIGIN is empty, or failed with exit 3. */
async function mailed(invite: Invite, print: (line: string) => void): Promise<number> {
  const outcome = await mailInvite(invite);
  if (outcome.mail === "failed") {
    print(`mail_failed: ${outcome.mailCode}: no mail went to ${invite.email}; the invite is made`);
    return EXIT.mailFailed;
  }
  if (outcome.mail === "skipped") {
    return skipped("APP_PUBLIC_ORIGIN is empty, and a path alone is no use in a mail", print);
  }
  print(`mail_sent: ${invite.email}`);
  return EXIT.done;
}

function skipped(reason: string, print: (line: string) => void): number {
  print(`mail_skipped: ${reason}`);
  return EXIT.done;
}

function parse(
  args: string[],
): { email: string; named: string; chosen: boolean; mail: boolean } | null {
  try {
    const options = { workspace: { type: "string" }, "no-mail": { type: "boolean" } } as const;
    const { positionals, values } = parseArgs({ args, options, allowPositionals: true });
    const email = positionals.length === 1 ? normalizeEmail(positionals[0]) : null;
    if (email === null) return null;
    return {
      email,
      named: values.workspace ?? settings.WORKSPACE_SLUG,
      chosen: values.workspace !== undefined,
      mail: values["no-mail"] !== true,
    };
  } catch {
    return null; // an unknown option, or --workspace without a value
  }
}

if (import.meta.main) {
  // On Linux, writes to a pipe or a terminal are synchronous: nothing is lost by exiting here, and
  // exiting closes the database clients the commands opened.
  process.exit(await runInvite(process.argv.slice(2), (line) => console.log(line)));
}
