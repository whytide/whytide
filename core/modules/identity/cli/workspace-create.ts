// `pnpm workspace:create --org <organization slug or id> --name <workspace name> --slug <slug>
// --admin-email <email> [--admin-name <name>] [--no-mail]` (README.md "The tenant commands"): an
// engineer adds a workspace to an organization, its admin the Owner, then mails the admin. The
// workspace spends its organization's credits. Each line starts with a code: workspace_created, the
// mail's, sign_in_page; or the refusal's.
import { parseArgs } from "node:util";
import { isAppError } from "@whytide/platform";
import {
  createWorkspace,
  findOrganization,
  findOrganizationBySlug,
  type Organization,
  errors as tenancyErrors,
} from "@whytide/tenancy";
import { EXIT, WORKSPACE_CREATE_USAGE } from "./constants.ts";
import {
  ADMIN_OPTIONS,
  adminOf,
  adminUser,
  mailAdmin,
  type Print,
  refused,
} from "./tenant-admin.ts";

const OPTIONS = {
  org: { type: "string" },
  name: { type: "string" },
  slug: { type: "string" },
  ...ADMIN_OPTIONS,
} as const;

/** The command with its arguments; the exit code: 0 made, 1 refused, 2 usage, 3 the mail failed. */
export async function runWorkspaceCreate(args: string[], print: Print): Promise<number> {
  const parsed = parse(args);
  if (parsed === null) {
    print(WORKSPACE_CREATE_USAGE);
    return EXIT.usage;
  }
  const { org, name, slug, admin } = parsed;
  try {
    const organization = await organizationNamed(org);
    if (organization === null) {
      print(`organization_not_found: ${org}`);
      return EXIT.refused;
    }
    const user = await adminUser(admin, print);
    if (user === null) return EXIT.refused;
    const input = { organizationId: organization.id, name, slug, ownerUserId: user.id };
    const { workspace } = await createWorkspace(input);
    const where = `workspace ${workspace.slug} (${workspace.id})`;
    print(`workspace_created: ${organization.name}, ${where}, Owner ${admin.email}`);
    const names = { workspace: workspace.name, organization: organization.name };
    return await mailAdmin(admin, names, "the workspace is", print);
  } catch (error) {
    return refused(error, slug, print);
  }
}

/**
 * The organization --org names: an id has an underscore, a slug none (tenancy's docs/concepts.md);
 * a value that is neither names none.
 */
async function organizationNamed(named: string): Promise<Organization | null> {
  if (named.includes("_")) return findOrganization(named);
  try {
    return await findOrganizationBySlug(named);
  } catch (error) {
    if (isAppError(error) && error.code === tenancyErrors.tenancy_input_invalid) return null;
    throw error;
  }
}

function parse(args: string[]) {
  try {
    const { values } = parseArgs({ args, options: OPTIONS });
    const admin = adminOf(values);
    const { org, name, slug } = values;
    return admin && org && name && slug ? { org, name, slug, admin } : null;
  } catch {
    return null; // an unknown option, a positional, or an option without its value
  }
}

if (import.meta.main) {
  // On Linux, writes to a pipe or a terminal are synchronous: nothing is lost by exiting here, and
  // exiting closes the database clients the commands opened.
  process.exit(await runWorkspaceCreate(process.argv.slice(2), (line) => console.log(line)));
}
