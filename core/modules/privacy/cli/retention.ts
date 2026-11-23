// `pnpm retention:check [--workspace <id or slug>]` (README.md "The 30-day rule", docs/runbook.md
// "The 30-day rule"): the 30-day rule's candidates as of now, counted per workspace, every workspace
// by default, read as the job reads them; it writes nothing. A line per workspace,
// `retention_candidates: <workspaceId> <n>`, then `retention_total: <n>`. It never prints a person:
// a refusal prints its code alone, and a failure its kind.
import { parseArgs } from "node:util";
import { isAppError } from "@whytide/platform";
import { findWorkspace, findWorkspaceBySlug, listWorkspaceIds } from "@whytide/tenancy";
import { kindOf } from "../domain/kind.ts";
import { cutoffOf } from "../domain/retention/candidates.ts";
import { candidatesOf } from "../domain/retention/job.ts";

const USAGE = "usage: pnpm retention:check [--workspace <id or slug>]";

/** The workspaces named: every one, or the one with the id or the slug; null for none. */
async function workspacesOf(named: string | undefined): Promise<string[] | null> {
  if (named === undefined) return listWorkspaceIds();
  // An id has an underscore and a slug none (tenancy's docs/concepts.md).
  const found = named.includes("_") ? await findWorkspace(named) : await findWorkspaceBySlug(named);
  return found === null ? null : [found.id];
}

/**
 * The command with its arguments; the exit code: 0 counted, 1 refused or failed, 2 a usage error.
 * `now` is for tests: the cutoff is RETENTION_NEVER_CONTACTED_DAYS days before it.
 */
export async function runRetentionCheck(
  args: string[],
  print: (line: string) => void,
  now: Date = new Date(),
): Promise<number> {
  let named: string | undefined;
  try {
    ({ workspace: named } = parseArgs({ args, options: { workspace: { type: "string" } } }).values);
  } catch {
    // an unknown option, a positional, or --workspace without its value
    print(USAGE);
    return 2;
  }
  try {
    const workspaceIds = await workspacesOf(named);
    if (workspaceIds === null) {
      print(`workspace_not_found: no single workspace is ${named}`);
      return 1;
    }
    const cutoff = cutoffOf(now);
    let total = 0;
    for (const workspaceId of workspaceIds) {
      const found = (await candidatesOf(workspaceId, cutoff)).length;
      print(`retention_candidates: ${workspaceId} ${found}`);
      total += found;
    }
    print(`retention_total: ${total}`);
    return 0;
  } catch (error) {
    if (isAppError(error) && error.status < 500) print(error.code);
    else print(`retention_check_failed: ${kindOf(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  // Exiting closes the database clients the command opened; console.log to a pipe is synchronous.
  process.exit(await runRetentionCheck(process.argv.slice(2), (line) => console.log(line)));
}
