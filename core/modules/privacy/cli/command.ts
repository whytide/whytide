// The one shape of the commands that delete a person (README.md "The deletion script", "Deleting a
// lead"): `pnpm <name> --workspace <id or slug> (--linkedin-url <url> | --email <address> | --person
// <id>) --operator <name> [--dry-run]`. It prints the rows deleted, by module and table, then the log
// row's id; it never prints the person's URL, email address, name or id: a refusal prints its code
// alone, and a failure its kind, since an error's message can quote a query's values. An address
// finds a person by its hash, one without a LinkedIn profile too (gamma-rf-050).
import { parseArgs } from "node:util";
import { isAppError } from "@whytide/platform";
import { findWorkspaceBySlug } from "@whytide/tenancy";
import type { Erasure, ErasureRequest, ErasureSkipped } from "../domain/erase/erase.ts";
import { kindOf } from "../domain/kind.ts";

/** A command: its root script's name, its run, and the words of its end and failure lines. */
export type PersonCommand = {
  /** The root script, in the usage line: `erase`, `lead:delete`. */
  readonly name: string;
  readonly run: (
    request: Pick<ErasureRequest, "workspaceId" | "person" | "operator" | "dryRun">,
  ) => Promise<Erasure | ErasureSkipped>;
  /** The end line's word: `<done>: <era_ id>, <n> rows`. */
  readonly done: string;
  /** A failure's code: `<failed>: <code or class>, nothing changed`. */
  readonly failed: string;
};

type Values = {
  workspace?: string;
  "linkedin-url"?: string;
  email?: string;
  person?: string;
  operator?: string;
  "dry-run"?: boolean;
};

const OPTIONS = {
  workspace: { type: "string" },
  "linkedin-url": { type: "string" },
  email: { type: "string" },
  person: { type: "string" },
  operator: { type: "string" },
  "dry-run": { type: "boolean" },
} as const;

/**
 * The command with its arguments; the exit code: 0 done (or counted), 1 refused or failed, with
 * nothing changed, 2 a usage error.
 */
export async function runPersonCommand(
  command: PersonCommand,
  args: string[],
  print: (line: string) => void,
): Promise<number> {
  let values: Values = {};
  try {
    ({ values } = parseArgs({ args, options: OPTIONS }));
  } catch {
    // an unknown option, or one without its value: the usage below
  }
  const { workspace: named, person: id, "linkedin-url": linkedinUrl, email } = values;
  const operator = values.operator?.trim() ?? "";
  // The person by exactly one of their id, URL and address.
  const keys = [id, linkedinUrl, email].filter((key) => key !== undefined);
  if (named === undefined || operator === "" || keys.length !== 1) {
    print(
      `usage: pnpm ${command.name} --workspace <id or slug> (--linkedin-url <url> | --email <address> | --person <id>) --operator <name> [--dry-run]`,
    );
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
    const person = personOf(id, linkedinUrl, email);
    const answer = await command.run({ workspaceId, person, operator, dryRun });
    if ("skipped" in answer) {
      print(answer.skipped);
      return 1;
    }
    let rows = 0;
    for (const [module, tables] of Object.entries(answer.counts)) {
      for (const [table, count] of Object.entries(tables)) {
        print(`${module}.${table}: ${count}`);
        rows += count;
      }
    }
    print(
      dryRun
        ? `dry_run: ${rows} rows counted, all rolled back`
        : `${command.done}: ${answer.logId}, ${rows} rows`,
    );
    return 0;
  } catch (error) {
    if (isAppError(error) && error.status < 500) print(error.code);
    else print(`${command.failed}: ${kindOf(error)}, nothing changed`);
    return 1;
  }
}

/** The person by the one key the command was given: the id, else the URL, else the address. */
function personOf(id?: string, linkedinUrl?: string, email?: string): ErasureRequest["person"] {
  if (id !== undefined) return { id };
  if (linkedinUrl !== undefined) return { linkedinUrl };
  return { email: email as string };
}
