// `pnpm -F contacts companies:link [--workspace <id>]` (README.md "Shared companies", gamma-rf-010):
// an engineer runs it once after the deploy that brings the shared companies, in one workspace or in
// every one, to link each company row of the workspaces to its shared company, LINK_BATCH ids per
// read and one tenant run per row. Safe to run again: a second run finds nothing to link. It prints
// counts only: one line, starting with companies_linked, or the refusal's code.
import { parseArgs } from "node:util";
import { type PrismaClient, withTenant } from "@whytide/db";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { listWorkspaceIds } from "@whytide/tenancy";
import { linkCompany, unlinkedCompanies } from "../domain/companies/link-all.ts";

const USAGE = "usage: pnpm -F contacts companies:link [--workspace <id>]";
const principal = servicePrincipal("contacts");

/**
 * The command with its arguments; the exit code: 0 done, 1 refused, 2 a usage error. `client` is a
 * test's (`asRole("app")`), the process's own by default.
 */
export async function runCompaniesLink(
  args: string[],
  print: (line: string) => void,
  client?: PrismaClient,
): Promise<number> {
  let workspace: string | undefined;
  try {
    const { values } = parseArgs({ args, options: { workspace: { type: "string" } } });
    workspace = values.workspace;
  } catch {
    print(USAGE);
    return 2;
  }
  try {
    const workspaceIds = workspace === undefined ? await listWorkspaceIds() : [workspace];
    const total = { read: 0, linked: 0, no_key: 0, no_group: 0 };
    for (const workspaceId of workspaceIds) {
      const run = <T>(fn: () => Promise<T>) =>
        withTenant({ workspaceId, principal }, fn, { client });
      let after: string | null = null;
      for (;;) {
        const rowIds: string[] = await run(() => unlinkedCompanies(after));
        for (const id of rowIds) total[await run(() => linkCompany(id))] += 1;
        total.read += rowIds.length;
        if (rowIds.length === 0) break;
        after = rowIds.at(-1) ?? null;
      }
    }
    const { read, linked } = total;
    print(
      `companies_linked: ${linked} linked, ${total.no_key} without a key, ${total.no_group} without a group of ${read} read in ${workspaceIds.length} workspaces`,
    );
    return 0;
  } catch (error) {
    if (!isAppError(error) || error.status >= 500) throw error;
    print(`${error.code}: ${workspace ?? "every workspace"}`);
    return 1;
  }
}

if (import.meta.main) {
  // Exiting closes the database clients the command opened; console.log to a pipe is synchronous.
  process.exit(await runCompaniesLink(process.argv.slice(2), (line) => console.log(line)));
}
