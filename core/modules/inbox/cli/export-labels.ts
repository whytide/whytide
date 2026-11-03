// `pnpm inbox:export-labels [--workspace <id or slug>] [--week <ISO week>]` (README.md "The reply
// golden set"): the operator exports the reply golden set of every workspace, or of the one named, as
// GET …/inbox/exports/reply-labels.jsonl does, each in its own tenant run as the inbox service, then
// prints the two numbers beta's "Done when" asks for. Each line starts with a code and holds counts,
// keys and codes only. The totals add the workspaces' counts here, never in one query across them.
import { parseArgs } from "node:util";
import { isAppError, servicePrincipal } from "@whytide/platform";
import {
  findWorkspace,
  findWorkspaceBySlug,
  listWorkspaceIds,
  errors as tenancyErrors,
} from "@whytide/tenancy";
import { exportReplyLabels, type ReplyLabelsFile } from "../domain/export/reply-labels.ts";
import { weekRange } from "../domain/export/week.ts";
import { errors } from "../errors.ts";
import { EXIT, ID_MARK, OPTIONS, SERVER_ERROR, SERVICE, USAGE } from "./constants.ts";

export type Print = (line: string) => void;

/**
 * The command with its arguments: a `reply_labels_written` line per workspace, then
 * `reply_labels_total`. The exit code: 0 written, 1 refused, 2 a usage error or week_invalid.
 */
export async function runExportLabels(
  args: string[],
  print: Print,
  now: Date = new Date(),
): Promise<number> {
  const options = parseOptions(args);
  if (options === null) {
    print(USAGE);
    return EXIT.usage;
  }
  const { workspace: named, week } = options;
  // Before any workspace: a refused week writes nothing.
  if (week !== undefined && !isWeek(week, now)) {
    print(`${errors.week_invalid}: ${week}`);
    return EXIT.usage;
  }
  const workspaceIds = named === undefined ? await listWorkspaceIds() : await workspaceNamed(named);
  if (workspaceIds === null) {
    print(`${tenancyErrors.workspace_not_found}: ${named}`);
    return EXIT.refused;
  }
  const totals = { labeled: 0, positive: 0, workspaces: 0, testers: new Set<string>() };
  for (const workspaceId of workspaceIds) {
    let file: ReplyLabelsFile;
    try {
      file = await exportReplyLabels(
        { workspaceId, principal: servicePrincipal(SERVICE) },
        { week },
        now,
      );
    } catch (error) {
      if (!isAppError(error) || error.status >= SERVER_ERROR) throw error;
      print(`${error.code}: ${workspaceId}`);
      return EXIT.refused;
    }
    print(`reply_labels_written: ${file.key}, ${file.lines} lines, ${file.positive} positive`);
    totals.labeled += file.lines;
    totals.positive += file.positive;
    if (file.positive > 0) totals.workspaces += 1;
    for (const owner of file.positiveOwners) totals.testers.add(owner);
  }
  const { labeled, positive, workspaces, testers } = totals;
  print(
    `reply_labels_total: ${labeled} labeled, ${positive} positive, ${workspaces} workspaces with a positive reply, ${testers.size} testers with a positive reply`,
  );
  return EXIT.written;
}

/** The options, or null for a usage error: an unknown option, a positional, an option's value missing. */
function parseOptions(args: string[]): { workspace?: string; week?: string } | null {
  try {
    return parseArgs({ args, options: OPTIONS }).values;
  } catch {
    return null;
  }
}

/** Whether the week is one the export takes: an ISO week of its year that has started by `now`. */
function isWeek(week: string, now: Date): boolean {
  try {
    weekRange(week, now);
    return true;
  } catch (error) {
    if (isAppError(error) && error.code === errors.week_invalid) return false;
    throw error;
  }
}

/**
 * The workspace --workspace names, as a list of its id: by id, which has an underscore, else by slug;
 * null for none, a value that is neither, or a slug two organizations share.
 */
async function workspaceNamed(named: string): Promise<string[] | null> {
  try {
    const workspace = named.includes(ID_MARK)
      ? await findWorkspace(named)
      : await findWorkspaceBySlug(named);
    return workspace === null ? null : [workspace.id];
  } catch (error) {
    if (isAppError(error) && error.code === tenancyErrors.tenancy_input_invalid) return null;
    throw error;
  }
}

if (import.meta.main) {
  // Exiting closes the database clients the command opened; console.log to a pipe is synchronous.
  process.exit(await runExportLabels(process.argv.slice(2), (line) => console.log(line)));
}
