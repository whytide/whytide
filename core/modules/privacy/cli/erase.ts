// `pnpm erase --workspace <id or slug> (--linkedin-url <url> | --email <address> | --person <id>)
// --operator <name> [--dry-run]` (README.md "The deletion script", docs/runbook.md): erases a person
// from a workspace, every module's rows in one tenant run, and prints the rows deleted, by module and
// table, then the log row's id. It never prints the person's URL, email address, name or id: a
// refusal prints its code alone, and a failure its kind, since an error's message can quote a
// query's values (command.ts).
import { erase } from "../domain/erase/erase.ts";
import { type PersonCommand, runPersonCommand } from "./command.ts";

const ERASE: PersonCommand = {
  name: "erase",
  run: (request) => erase(request),
  done: "erased",
  failed: "erase_failed",
};

/**
 * The command with its arguments; the exit code: 0 erased (or counted), 1 refused or failed, with
 * nothing changed, 2 a usage error.
 */
export function runErase(args: string[], print: (line: string) => void): Promise<number> {
  return runPersonCommand(ERASE, args, print);
}

if (import.meta.main) {
  // Exiting closes the database clients the command opened; console.log to a pipe is synchronous.
  process.exit(await runErase(process.argv.slice(2), (line) => console.log(line)));
}
