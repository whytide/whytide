// `pnpm -F contacts countries:backfill [--workspace <id>]` (README "The place list", gamma-en-075):
// an engineer fills location_country for the persons whose country is empty and whose location the
// place list can now read, in one workspace or in every one, BACKFILL_BATCH persons per tenant run.
// It prints counts only: one line, starting with countries_backfilled, or the refusal's code.
import { parseArgs } from "node:util";
import { type PrismaClient, withTenant } from "@whytide/db";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { listWorkspaceIds } from "@whytide/tenancy";
import { type BackfillBatch, backfillCountries } from "../domain/countries-backfill.ts";

const USAGE = "usage: pnpm -F contacts countries:backfill [--workspace <id>]";
const principal = servicePrincipal("contacts");

/**
 * The command with its arguments; the exit code: 0 done, 1 refused, 2 a usage error. `client` is a
 * test's (`asRole("app")`), the process's own by default.
 */
export async function runCountriesBackfill(
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
    const total = { read: 0, filled: 0, kept: 0, unread: 0 };
    for (const workspaceId of workspaceIds) {
      let after: string | null = null;
      for (;;) {
        const batch: BackfillBatch = await withTenant(
          { workspaceId, principal },
          () => backfillCountries(after),
          { client },
        );
        total.read += batch.read;
        total.filled += batch.filled;
        total.kept += batch.kept;
        total.unread += batch.unread;
        if (batch.last === null) break;
        after = batch.last;
      }
    }
    const { read, filled, kept, unread } = total;
    print(
      `countries_backfilled: ${filled} filled, ${unread} unread, ${kept} kept of ${read} read in ${workspaceIds.length} workspaces`,
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
  process.exit(await runCountriesBackfill(process.argv.slice(2), (line) => console.log(line)));
}
