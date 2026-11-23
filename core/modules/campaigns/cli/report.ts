// `pnpm campaigns:report [--workspace <id or slug>] [--since <YYYY-MM-DD>]` (README.md "Commands",
// docs/runbook.md "The report"): the operator reads every "Done when" figure that code can measure,
// from the logs. Every workspace tenancy lists, or the one named, is read in its own tenant run as the
// campaigns service, never in one query across workspaces; the lines add them up. It loads campaigns,
// approvals, contacts, linkedin and tenancy through their index.ts, calls no provider and writes
// nothing. Each line starts with a code (lines.ts) and holds ids, codes, counts, days and instants.
// gamma-p7-050: gamma's lines follow beta's (gamma-lines.ts); the exit code still reads the three
// zeros, LinkedIn's, until email's two join them in the email phase.
import { parseArgs } from "node:util";
import { disconnectTenantClient, type PrismaClient, withTenant } from "@whytide/db";
import { isAppError, servicePrincipal } from "@whytide/platform";
import {
  findWorkspace,
  findWorkspaceBySlug,
  listWorkspaceIds,
  errors as tenancyErrors,
} from "@whytide/tenancy";
import { now } from "../domain/clock.ts";
import { EVERY_ROW_SINCE_MS, MS_PER_DAY } from "../domain/report/constants.ts";
import { midnightOf, utcDay } from "../domain/report/days.ts";
import {
  type ReportPeriod,
  reportWorkspace,
  type WorkspaceReport,
} from "../domain/report/report.ts";
import {
  DECISION_WINDOW_DAYS,
  EXIT,
  ID_MARK,
  OPTIONS,
  REPORT_ACCEPTANCE_MIN_AGE_DAYS,
  REPORT_RUN_TIMEOUT_MS,
  REVIEW_APPROVAL_WINDOW_DAYS,
  SERVICE,
  SINCE_DAY,
  USAGE,
} from "./constants.ts";
import { reportLines, zerosHold } from "./lines.ts";

export type Print = (line: string) => void;
/** For tests: the client the workspaces' runs open on, `asRole("app")`; the process's by default. */
export type ReportOptions = { readonly client?: PrismaClient };

/**
 * The command with its arguments, the run's instant campaigns' clock. The exit code: 0 the report
 * ran and the three zeros hold; 1 a zero is broken, or workspace_not_found; 2 a usage error (an
 * unknown option, a positional, a malformed day).
 */
export async function runReport(
  args: string[],
  print: Print,
  options: ReportOptions = {},
): Promise<number> {
  const parsed = parseOptions(args);
  const since = parsed === null ? null : sinceOf(parsed.since);
  if (parsed === null || since === null) {
    print(USAGE);
    return EXIT.usage;
  }
  const workspaceIds =
    parsed.workspace === undefined
      ? await listWorkspaceIds()
      : await workspaceNamed(parsed.workspace);
  if (workspaceIds === null) {
    print(`${tenancyErrors.workspace_not_found}: ${parsed.workspace}`);
    return EXIT.violations;
  }
  const at = now();
  const period: ReportPeriod = {
    since,
    now: at,
    sentBefore: new Date(at.getTime() - REPORT_ACCEPTANCE_MIN_AGE_DAYS * MS_PER_DAY),
    decisionWindowDays: DECISION_WINDOW_DAYS,
    reviewWindowDays: REVIEW_APPROVAL_WINDOW_DAYS,
  };
  const reports: WorkspaceReport[] = [];
  for (const workspaceId of workspaceIds) {
    const tenant = { workspaceId, principal: servicePrincipal(SERVICE) };
    const settings = { client: options.client, timeout: REPORT_RUN_TIMEOUT_MS };
    reports.push(await withTenant(tenant, () => reportWorkspace(period), settings));
  }
  for (const line of reportLines(reports)) print(line);
  return zerosHold(reports) ? EXIT.clean : EXIT.violations;
}

/** The options, or null for a usage error: an unknown option, a positional, a value missing. */
function parseOptions(args: string[]): { workspace?: string; since?: string } | null {
  try {
    return parseArgs({ args, options: OPTIONS }).values;
  } catch {
    return null;
  }
}

/** --since's UTC midnight, the epoch without it; null for a value that is no calendar day. */
function sinceOf(day: string | undefined): Date | null {
  if (day === undefined) return new Date(EVERY_ROW_SINCE_MS);
  if (!SINCE_DAY.test(day)) return null;
  const midnight = midnightOf(day);
  // A day past its month's end parses as a later one: the round trip refuses it.
  return Number.isNaN(midnight) || utcDay(new Date(midnight)) !== day ? null : new Date(midnight);
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
  // On Linux, writes to a pipe or a terminal are synchronous: nothing is lost by exiting here. The
  // runs' client is ended first; exiting ends tenancy's, as identity's commands do.
  let code: number;
  try {
    code = await runReport(process.argv.slice(2), (line) => console.log(line));
  } finally {
    await disconnectTenantClient();
  }
  process.exit(code);
}
