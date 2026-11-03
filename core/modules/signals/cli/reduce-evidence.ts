// `pnpm evidence:reduce --workspace <id or slug>` (README.md "Reduction"): an engineer reduces a
// workspace's evidence past its kind's lookback now, the rows the daily workflow would, a batch per
// tenant run. The line starts with a code: evidence_reduced with the count, or the refusal's.
import { parseArgs } from "node:util";
import { type PrismaClient, withTenant } from "@whytide/db";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { findWorkspaceBySlug } from "@whytide/tenancy";
import { reduceEvidence } from "../domain/reduce/reduce.ts";

const USAGE = "usage: pnpm evidence:reduce --workspace <id or slug>";

/**
 * The command with its arguments; the exit code: 0 reduced, 1 refused, 2 a usage error. `client` is
 * a test's (`asRole("app")`), the process's own by default.
 */
export async function runReduceEvidence(
  args: string[],
  print: (line: string) => void,
  client?: PrismaClient,
): Promise<number> {
  let values: { workspace?: string } = {};
  try {
    ({ values } = parseArgs({ args, options: { workspace: { type: "string" } } }));
  } catch {
    // an unknown option, or one without its value: the usage below
  }
  const named = values.workspace;
  if (named === undefined) {
    print(USAGE);
    return 2;
  }
  try {
    // An id has an underscore and a slug none (tenancy's docs/concepts.md).
    const workspaceId = named.includes("_") ? named : (await findWorkspaceBySlug(named))?.id;
    if (workspaceId === undefined) {
      print(`workspace_not_found: no single workspace has the slug ${named}: pass its id`);
      return 1;
    }
    const tenant = { workspaceId, principal: servicePrincipal("signals") };
    const reduced = await reduceEvidence((fn) => withTenant(tenant, fn, { client }));
    print(`evidence_reduced: ${reduced} in ${workspaceId}`);
    return 0;
  } catch (error) {
    if (!isAppError(error) || error.status >= 500) throw error;
    print(`${error.code}: ${named}`);
    return 1;
  }
}

if (import.meta.main) {
  // Exiting closes the database clients the command opened; console.log to a pipe is synchronous.
  process.exit(await runReduceEvidence(process.argv.slice(2), (line) => console.log(line)));
}
