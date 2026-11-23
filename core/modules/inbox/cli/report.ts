// `pnpm inbox:report [--workspace <id or slug>] [--since <YYYY-MM-DD>]` (README.md "The report";
// gamma-p7-060): the operator reads gamma's reply numbers, the LinkedIn reply rate on signal-sourced
// leads, the positive conversations per active workspace-week and the classifier's agreement with
// the threads' owners. Every workspace tenancy lists, or the one named, is read in its own tenant run
// as the service `inbox`, never in one query across workspaces; the figures add them up. It reads
// campaigns, contacts and linkedin through their index.ts, calls no provider and writes nothing.
// Each line holds ids, weeks, counts and shares only.
import { parseArgs } from "node:util";
import { disconnectTenantClient, type PrismaClient, withTenant } from "@whytide/db";
import { servicePrincipal } from "@whytide/platform";
import { listWorkspaceIds, errors as tenancyErrors } from "@whytide/tenancy";
import { figures } from "../domain/report/figures.ts";
import { readFacts, type WorkspaceFacts } from "../domain/report/read.ts";
import {
  DAY_LENGTH,
  EVERY_ROW_SINCE_MS,
  MIDNIGHT_SUFFIX,
  REPORT_EXIT,
  REPORT_OPTIONS,
  REPORT_RUN_TIMEOUT_MS,
  REPORT_USAGE,
  SERVICE,
  SINCE_DAY,
} from "./constants.ts";
import { reportLines } from "./report-lines.ts";
import { workspaceNamed } from "./workspace.ts";

export type Print = (line: string) => void;
/** For tests: the client the runs open on, `asRole("app")`; the process's by default. */
export type ReportOptions = { readonly client?: PrismaClient };

/**
 * The command with its arguments. The exit code: 0 printed; 1 refused, workspace_not_found; 2 a
 * usage error (an unknown option, a positional, a value missing, a malformed day).
 */
export async function runReport(
  args: string[],
  print: Print,
  options: ReportOptions = {},
): Promise<number> {
  const parsed = parseOptions(args);
  const since = parsed === null ? null : sinceOf(parsed.since);
  if (parsed === null || since === null) {
    print(REPORT_USAGE);
    return REPORT_EXIT.usage;
  }
  const workspaceIds =
    parsed.workspace === undefined
      ? await listWorkspaceIds()
      : await workspaceNamed(parsed.workspace);
  if (workspaceIds === null) {
    print(`${tenancyErrors.workspace_not_found}: ${parsed.workspace}`);
    return REPORT_EXIT.refused;
  }
  const facts: WorkspaceFacts[] = [];
  for (const workspaceId of workspaceIds) {
    const tenant = { workspaceId, principal: servicePrincipal(SERVICE) };
    const settings = { client: options.client, timeout: REPORT_RUN_TIMEOUT_MS };
    facts.push(await withTenant(tenant, () => readFacts(since), settings));
  }
  for (const line of reportLines(figures(facts, since))) print(line);
  return REPORT_EXIT.printed;
}

/** The options, or null for a usage error: an unknown option, a positional, a value missing. */
function parseOptions(args: string[]): { workspace?: string; since?: string } | null {
  try {
    return parseArgs({ args, options: REPORT_OPTIONS }).values;
  } catch {
    return null;
  }
}

/** --since's UTC midnight, the epoch without it; null for a value that is no calendar day. */
function sinceOf(day: string | undefined): Date | null {
  if (day === undefined) return new Date(EVERY_ROW_SINCE_MS);
  if (!SINCE_DAY.test(day)) return null;
  const midnight = new Date(`${day}${MIDNIGHT_SUFFIX}`);
  // A day past its month's end is no date: the round trip refuses it.
  const valid = !Number.isNaN(midnight.getTime());
  return valid && midnight.toISOString().slice(0, DAY_LENGTH) === day ? midnight : null;
}

if (import.meta.main) {
  // The runs' client is ended first; console.log to a pipe is synchronous, so nothing is lost.
  let code: number;
  try {
    code = await runReport(process.argv.slice(2), (line) => console.log(line));
  } finally {
    await disconnectTenantClient();
  }
  process.exit(code);
}
