// `pnpm export:golden --workspace <id or slug> [--week <ISO week>]` (README "The golden set"): an
// engineer exports the workspace's golden set, as GET …/qualification/exports/golden-set.jsonl does,
// to its exports/ folder. The line starts with a code: golden_set_written, or the refusal's.
import { parseArgs } from "node:util";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { findWorkspaceBySlug } from "@whytide/tenancy";
import { exportGoldenSet } from "../domain/export/golden-set.ts";

const USAGE = "usage: pnpm export:golden --workspace <id or slug> [--week <ISO week>]";

/** The command with its arguments; the exit code: 0 written, 1 refused, 2 a usage error. */
export async function runExportGolden(
  args: string[],
  print: (line: string) => void,
): Promise<number> {
  const options = { workspace: { type: "string" }, week: { type: "string" } } as const;
  let values: { workspace?: string; week?: string } = {};
  try {
    ({ values } = parseArgs({ args, options }));
  } catch {
    // an unknown option, or one without its value: the usage below
  }
  const { workspace: named, week } = values;
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
    const context = { workspaceId, principal: servicePrincipal("qualification") };
    const { key, lines } = await exportGoldenSet(context, { week });
    print(`golden_set_written: ${key}, ${lines} lines`);
    return 0;
  } catch (error) {
    if (!isAppError(error) || error.status >= 500) throw error;
    print(`${error.code}: ${[named, week].filter(Boolean).join(" ")}`);
    return 1;
  }
}

if (import.meta.main) {
  // Exiting closes the database clients the command opened; console.log to a pipe is synchronous.
  process.exit(await runExportGolden(process.argv.slice(2), (line) => console.log(line)));
}
