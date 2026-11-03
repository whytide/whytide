// `pnpm rescore --workspace <id or slug> [--person <id>]` (README "The re-score"): an engineer asks
// the worker to re-score a workspace's scored leads, or one person's, as POST …/qualification/rescore
// does. The line starts with a code: rescore_requested, or the refusal's.
import { parseArgs } from "node:util";
import { withTenant } from "@whytide/db";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { findWorkspaceBySlug } from "@whytide/tenancy";
import { givenClient } from "../domain/client.ts";
import { requestRescore } from "../domain/rescore.ts";

const USAGE = "usage: pnpm rescore --workspace <id or slug> [--person <id>]";

/** The command with its arguments; the exit code: 0 requested, 1 refused, 2 a usage error. */
export async function runRescore(args: string[], print: (line: string) => void): Promise<number> {
  const options = { workspace: { type: "string" }, person: { type: "string" } } as const;
  let values: { workspace?: string; person?: string } = {};
  try {
    ({ values } = parseArgs({ args, options }));
  } catch {
    // an unknown option, or one without its value: the usage below
  }
  const { workspace: named, person } = values;
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
    const personIds = person === undefined ? undefined : [person];
    const context = { workspaceId, principal: servicePrincipal("qualification") };
    const run = () => requestRescore({ personIds });
    const { requestId } = await withTenant(context, run, { client: givenClient() });
    print(`rescore_requested: ${requestId} for ${person ?? "every scored lead"} in ${workspaceId}`);
    return 0;
  } catch (error) {
    if (!isAppError(error) || error.status >= 500) throw error;
    print(`${error.code}: ${named}`);
    return 1;
  }
}

if (import.meta.main) {
  // Exiting closes the database clients the command opened; console.log to a pipe is synchronous.
  process.exit(await runRescore(process.argv.slice(2), (line) => console.log(line)));
}
