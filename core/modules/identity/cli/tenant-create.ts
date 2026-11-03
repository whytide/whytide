// `pnpm tenant:create --name <organization name> --slug <slug> --admin-email <email>
// [--admin-name <name>] [--no-mail]` (README.md "The tenant commands"): an engineer makes a tenant,
// an organization and its default workspace with the name and the slug, its admin their Owner, then
// mails the admin. The Owner membership lets them sign in: no invite is made. Each line starts with
// a code: organization_created, the mail's, sign_in_page; or the refusal's.
import { parseArgs } from "node:util";
import { bootstrapOrganization, findOrganizationBySlug } from "@whytide/tenancy";
import { EXIT, TENANT_CREATE_USAGE } from "./constants.ts";
import {
  ADMIN_OPTIONS,
  adminOf,
  adminUser,
  mailAdmin,
  type Print,
  refused,
} from "./tenant-admin.ts";

const OPTIONS = { name: { type: "string" }, slug: { type: "string" }, ...ADMIN_OPTIONS } as const;

/** The command with its arguments; the exit code: 0 made, 1 refused, 2 usage, 3 the mail failed. */
export async function runTenantCreate(args: string[], print: Print): Promise<number> {
  const parsed = parse(args);
  if (parsed === null) {
    print(TENANT_CREATE_USAGE);
    return EXIT.usage;
  }
  const { name, slug, admin } = parsed;
  try {
    // The slug first, so that a refused run makes no user.
    if ((await findOrganizationBySlug(slug)) !== null) {
      print(`organization_exists: ${slug}`);
      return EXIT.refused;
    }
    const user = await adminUser(admin, print);
    if (user === null) return EXIT.refused;
    const input = { name, workspaceSlug: slug, ownerUserId: user.id };
    const { organization, workspace } = await bootstrapOrganization(input);
    const where = `workspace ${workspace.slug} (${workspace.id})`;
    print(`organization_created: ${organization.name}, ${where}, Owner ${admin.email}`);
    const names = { workspace: workspace.name, organization: organization.name };
    return await mailAdmin(admin, names, "the organization and its workspace are", print);
  } catch (error) {
    return refused(error, slug, print);
  }
}

function parse(args: string[]) {
  try {
    const { values } = parseArgs({ args, options: OPTIONS });
    const admin = adminOf(values);
    const { name, slug } = values;
    return admin && name && slug ? { name, slug, admin } : null;
  } catch {
    return null; // an unknown option, a positional, or an option without its value
  }
}

if (import.meta.main) {
  // On Linux, writes to a pipe or a terminal are synchronous: nothing is lost by exiting here, and
  // exiting closes the database clients the commands opened.
  process.exit(await runTenantCreate(process.argv.slice(2), (line) => console.log(line)));
}
