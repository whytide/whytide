// `pnpm erase --workspace <id or slug> (--linkedin-url <url> | --person <id>) --operator <name>
// [--dry-run]` (README.md "The deletion script", docs/runbook.md): erases a person from a workspace,
// every module's rows in one tenant run, and prints the rows deleted, by module and table, then the
// log row's id. It never prints the person's URL, name or id: a refusal prints its code alone, and
// a failure its kind, since an error's message can quote a query's values.
import { parseArgs } from "node:util";
import { isAppError } from "@whytide/platform";
import { findWorkspaceBySlug } from "@whytide/tenancy";
import { erase } from "../domain/erase/erase.ts";

const USAGE =
  "usage: pnpm erase --workspace <id or slug> (--linkedin-url <url> | --person <id>) --operator <name> [--dry-run]";

type Values = {
  workspace?: string;
  "linkedin-url"?: string;
  person?: string;
  operator?: string;
  "dry-run"?: boolean;
};

/**
 * The command with its arguments; the exit code: 0 erased (or counted), 1 refused or failed, with
 * nothing changed, 2 a usage error.
 */
export async function runErase(args: string[], print: (line: string) => void): Promise<number> {
  const options = {
    workspace: { type: "string" },
    "linkedin-url": { type: "string" },
    person: { type: "string" },
    operator: { type: "string" },
    "dry-run": { type: "boolean" },
  } as const;
  let values: Values = {};
  try {
    ({ values } = parseArgs({ args, options }));
  } catch {
    // an unknown option, or one without its value: the usage below
  }
  const { workspace: named, person: id, "linkedin-url": linkedinUrl } = values;
  const operator = values.operator?.trim() ?? "";
  if (
    named === undefined ||
    operator === "" ||
    (id === undefined) === (linkedinUrl === undefined)
  ) {
    print(USAGE);
    return 2;
  }
  const dryRun = values["dry-run"] === true;
  try {
    // An id has an underscore and a slug none (tenancy's docs/concepts.md).
    const workspaceId = named.includes("_") ? named : (await findWorkspaceBySlug(named))?.id;
    if (workspaceId === undefined) {
      print(`workspace_not_found: no single workspace has the slug ${named}: pass its id`);
      return 1;
    }
    const person = id === undefined ? { linkedinUrl: linkedinUrl as string } : { id };
    const { logId, counts } = await erase({ workspaceId, person, operator, dryRun });
    let rows = 0;
    for (const [module, tables] of Object.entries(counts)) {
      for (const [table, count] of Object.entries(tables)) {
        print(`${module}.${table}: ${count}`);
        rows += count;
      }
    }
    print(
      dryRun ? `dry_run: ${rows} rows counted, all rolled back` : `erased: ${logId}, ${rows} rows`,
    );
    return 0;
  } catch (error) {
    if (isAppError(error) && error.status < 500) print(error.code);
    else print(`erase_failed: ${kindOf(error)}, nothing changed`);
    return 1;
  }
}

/** An error's code, or its class: never its message. */
function kindOf(error: unknown): string {
  const { code } = (error ?? {}) as { code?: unknown };
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "unknown";
}

if (import.meta.main) {
  // Exiting closes the database clients the command opened; console.log to a pipe is synchronous.
  process.exit(await runErase(process.argv.slice(2), (line) => console.log(line)));
}
