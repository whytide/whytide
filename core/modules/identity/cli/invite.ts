// `pnpm invite <email> [--workspace <id or slug>]` (README.md "The invite command"): an engineer
// invites an email to a workspace, WORKSPACE_SLUG by default, and gets the sign-in page's address to
// pass on, never a link that signs in. A second run for the email reports the invite and exits 0. On
// a database with no organization, the default workspace is made first, the email its Owner. Each
// line starts with a code: organization_created, invite_created, invite_exists, or the refusal's.
import { parseArgs } from "node:util";
import { isAppError } from "@whytide/platform";
import { findWorkspaceBySlug, settings } from "@whytide/tenancy";
import { bootstrapFirstWorkspace, createInvite } from "../domain/invites.ts";
import { normalizeEmail } from "../domain/rules.ts";
import { errors } from "../errors.ts";

const USAGE = "usage: pnpm invite <email> [--workspace <id or slug>]";

/** The command with its arguments; the exit code: 0 invited, 1 refused, 2 a usage error. */
export async function runInvite(args: string[], print: (line: string) => void): Promise<number> {
  const parsed = parse(args);
  if (parsed === null) {
    print(USAGE);
    return 2;
  }
  const { email, named, chosen } = parsed;
  // APP_PUBLIC_ORIGIN, the api's variable, is the web app's origin; unset, the path alone.
  const signIn = `${(process.env.APP_PUBLIC_ORIGIN ?? "").replace(/\/+$/, "")}/sign-in`;
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
      return 1;
    }
    await createInvite({ workspaceId, email });
    print(`invite_created: ${email} may sign in to ${workspaceId} at ${signIn}`);
  } catch (error) {
    if (!isAppError(error) || error.status >= 500) throw error;
    if (error.code !== errors.invite_exists) {
      print(`${error.code}: ${named}`);
      return 1;
    }
    print(`invite_exists: ${email} is invited to ${workspaceId} already; sign-in page ${signIn}`);
  }
  return 0;
}

function parse(args: string[]): { email: string; named: string; chosen: boolean } | null {
  try {
    const options = { workspace: { type: "string" } } as const;
    const { positionals, values } = parseArgs({ args, options, allowPositionals: true });
    const email = positionals.length === 1 ? normalizeEmail(positionals[0]) : null;
    if (email === null) return null;
    return {
      email,
      named: values.workspace ?? settings.WORKSPACE_SLUG,
      chosen: values.workspace !== undefined,
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
