// `pnpm lead:delete --workspace <id or slug> (--linkedin-url <url> | --email <address> | --person
// <id>) --operator <name> [--dry-run]` (README.md "Deleting a lead", docs/runbook.md): deletes a lead
// that no channel ever reached, with every row of the person's in one tenant run, and keeps no
// erased hash, so that the same person can be added again. It prints as `pnpm erase` does
// (command.ts), its end line `deleted: <era_ id>, <n> rows`; a refusal prints its code alone:
// person_contacted, person_suppressed, person_not_found, linkedin_url_invalid,
// contacts_input_invalid (a text that is no address), workspace_not_found.
import { deleteLead } from "../domain/lead-delete/delete.ts";
import { type PersonCommand, runPersonCommand } from "./command.ts";

const LEAD_DELETE: PersonCommand = {
  name: "lead:delete",
  run: (request) => deleteLead(request),
  done: "deleted",
  failed: "lead_delete_failed",
};

/**
 * The command with its arguments; the exit code: 0 deleted (or counted), 1 refused or failed, with
 * nothing changed, 2 a usage error.
 */
export function runLeadDelete(args: string[], print: (line: string) => void): Promise<number> {
  return runPersonCommand(LEAD_DELETE, args, print);
}

if (import.meta.main) {
  // Exiting closes the database clients the command opened; console.log to a pipe is synchronous.
  process.exit(await runLeadDelete(process.argv.slice(2), (line) => console.log(line)));
}
