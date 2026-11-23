// `pnpm -F enrichment emails:record [--workspace <id>]` (README.md "Email lookups", gamma-rf-040): an
// engineer runs it once, right after the migration that brings contacts' person_email_hashes and
// before members use the never-contact form, in one workspace or in every one: each contact point's
// address recorded for its person, whatever its status, RECORD_BATCH ids per read and one tenant run
// per contact point. Safe to run again. No contact point is changed or deleted; a person whose address
// a block on every channel holds has their lead suppressed, as a block does. It prints ids and counts
// only: a line per contact point whose address is blocked, held by another person or refused, then one
// line of counts starting with emails_recorded, or the refusal's code.
import { parseArgs } from "node:util";
import { type PrismaClient, withTenant } from "@whytide/db";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { listWorkspaceIds } from "@whytide/tenancy";
import {
  contactPointsAfter,
  type RecordOutcome,
  recordContactPoint,
} from "../domain/lookup/record-emails.ts";

const USAGE = "usage: pnpm -F enrichment emails:record [--workspace <id>]";
const principal = servicePrincipal("enrichment");

/**
 * The command with its arguments; the exit code: 0 done, 1 refused, 2 a usage error. `client` is a
 * test's (`asRole("app")`), the process's own by default.
 */
export async function runEmailsRecord(
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
    const total = { read: 0, recorded: 0, blocked: 0, other_person: 0, gone: 0, refused: 0 };
    for (const workspaceId of workspaceIds) {
      const run = <T>(fn: () => Promise<T>) =>
        withTenant({ workspaceId, principal }, fn, { client });
      let after: string | null = null;
      for (;;) {
        const pointIds: string[] = await run(() => contactPointsAfter(after));
        for (const id of pointIds) {
          const outcome = await recordOne(id, run, print);
          total[outcome] += 1;
          if (outcome === "blocked" || outcome === "other_person") print(`${outcome}: ${id}`);
        }
        total.read += pointIds.length;
        if (pointIds.length === 0) break;
        after = pointIds.at(-1) ?? null;
      }
    }
    const recorded = total.recorded + total.blocked;
    print(
      `emails_recorded: ${recorded} recorded, ${total.blocked} of them blocked, ${total.other_person} held by another person, ${total.refused} refused, ${total.gone} gone, of ${total.read} read in ${workspaceIds.length} workspaces`,
    );
    return 0;
  } catch (error) {
    if (!isAppError(error) || error.status >= 500) throw error;
    print(`${error.code}: ${workspace ?? "every workspace"}`);
    return 1;
  }
}

/** One contact point recorded in its own run; a refusal (a value that is no address) printed by id. */
async function recordOne(
  id: string,
  run: <T>(fn: () => Promise<T>) => Promise<T>,
  print: (line: string) => void,
): Promise<RecordOutcome | "refused"> {
  try {
    return await run(() => recordContactPoint(id));
  } catch (error) {
    if (!isAppError(error) || error.status >= 500) throw error;
    print(`refused: ${id} (${error.code})`);
    return "refused";
  }
}

if (import.meta.main) {
  // Exiting closes the database clients the command opened; console.log to a pipe is synchronous.
  process.exit(await runEmailsRecord(process.argv.slice(2), (line) => console.log(line)));
}
