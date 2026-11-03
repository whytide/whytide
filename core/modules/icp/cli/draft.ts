// `pnpm icp:draft --workspace <id or slug> [--brief <text> | --brief-file <path>] [--dry-run]
// [--replace]` (README "The script"): an engineer drafts the workspace's ICP from its Company
// Knowledge and the admin's brief. The script calls no model: it requests a draft, which the worker's
// icp_draft_profile makes, reads the ICP every two seconds until the draft ends, prints the proposal
// and, unless --dry-run, saves it through saveIcp, the ICP screen's command. Each line starts with a
// code or a field's name; none carries the brief or the company's text.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { type PrismaClient, withTenant } from "@whytide/db";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { findWorkspace, findWorkspaceBySlug } from "@whytide/tenancy";
import { getIcp, lockedIcpId, saveIcp } from "../domain/commands.ts";
import { type IcpDraft, readDraft, requestDraft } from "../domain/draft.ts";
import { hasTargeting } from "../domain/rules.ts";
import type { DraftProfileOutput } from "../schemas/draft-profile.ts";
import { icpBody } from "../schemas/icp.ts";
import {
  DRAFT_USAGE,
  EXIT,
  POLL_MS,
  PROPOSAL_FIELDS,
  RESCORE_CREDITS_PER_LEAD,
  TIMEOUT_MS,
} from "./constants.ts";

export type Print = (line: string) => void;
/** For tests: the database client, the reads' interval and time limit, the wait between two reads. */
export type DraftOptions = {
  readonly client?: PrismaClient;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly wait?: (ms: number) => Promise<unknown>;
};
type InRun = <T>(fn: () => Promise<T>) => Promise<T>;

const OPTIONS = {
  workspace: { type: "string" },
  brief: { type: "string" },
  "brief-file": { type: "string" },
  "dry-run": { type: "boolean" },
  replace: { type: "boolean" },
} as const;

/** The command with its arguments; the exit code is one of EXIT's. */
export async function runDraft(
  args: string[],
  print: Print,
  options: DraftOptions = {},
): Promise<number> {
  const parsed = parse(args);
  if (parsed === null) {
    print(DRAFT_USAGE);
    return EXIT.usage;
  }
  const { named, briefFile, replace } = parsed;
  let brief = parsed.brief ?? "";
  try {
    // pnpm runs the script in the module's folder: a relative path is the caller's (INIT_CWD).
    const from = process.env.INIT_CWD ?? process.cwd();
    if (briefFile !== undefined) brief = readFileSync(resolve(from, briefFile), "utf8");
  } catch {
    print(`brief_file_unreadable: ${briefFile}`);
    return EXIT.refused;
  }
  try {
    // An id has an underscore and a slug none (tenancy's docs/concepts.md).
    const workspace = named.includes("_")
      ? await findWorkspace(named)
      : await findWorkspaceBySlug(named);
    if (workspace === null) {
      print(`workspace_not_found: no single workspace is ${named}: pass its id`);
      return EXIT.refused;
    }
    const workspaceId = workspace.id;
    const context = { workspaceId, principal: servicePrincipal("icp") };
    const inRun: InRun = (fn) => withTenant(context, fn, { client: options.client });
    const draftRunId = await inRun(async () =>
      !replace && hasTargeting(await getIcp(workspaceId)) ? null : requestDraft(workspaceId, brief),
    );
    if (draftRunId === null) return notEmpty(workspaceId, print);
    print(`icp_draft_requested: ${draftRunId} in ${workspaceId}`);
    const draft = await awaitDraft(inRun, draftRunId, options);
    if (draft === null) {
      const seconds = (options.timeoutMs ?? TIMEOUT_MS) / 1000;
      print(`icp_draft_timed_out: no draft after ${seconds} seconds: is the worker running?`);
      return EXIT.timedOut;
    }
    if (draft.draftRunId !== draftRunId) {
      print(
        `icp_draft_superseded: a later request's run ${draft.draftRunId} replaced ${draftRunId}`,
      );
      return EXIT.superseded;
    }
    if (draft.status !== "drafted" || draft.pending === null) {
      print(`icp_draft_failed: ${draft.error}`);
      return EXIT.failed;
    }
    const { fields, promptVersion } = draft.pending;
    print(`icp_drafted: ${draftRunId}, prompt version ${promptVersion}`);
    for (const field of PROPOSAL_FIELDS) print(`${field}: ${[fields[field]].flat().join(", ")}`);
    if (parsed.dryRun) {
      print("icp_draft_not_saved: --dry-run");
      return EXIT.done;
    }
    return await save(inRun, workspaceId, fields, replace, print);
  } catch (error) {
    if (!isAppError(error) || error.status >= 500) throw error;
    print(`${error.code}: ${named}`);
    return EXIT.refused;
  }
}

/** The draft once it ended or a later request's run replaced it; null when the time ran out. */
async function awaitDraft(
  inRun: InRun,
  draftRunId: string,
  options: DraftOptions,
): Promise<IcpDraft | null> {
  const deadline = Date.now() + (options.timeoutMs ?? TIMEOUT_MS);
  const wait = options.wait ?? sleep;
  for (;;) {
    // Each read its own short run: a run holds a connection for five seconds at most.
    const draft = await inRun(() => readDraft());
    const ended = draft.status === "drafted" || draft.status === "failed";
    if (draft.draftRunId !== draftRunId || ended) return draft;
    if (Date.now() >= deadline) return null;
    await wait(options.pollMs ?? POLL_MS);
  }
}

/**
 * Saves the proposal through saveIcp once it passes the PUT body's schema, the ICP still without
 * targeting unless --replace; the criteria stay. A targeting change moves the version, and its
 * icp.updated re-scores the workspace's leads.
 */
async function save(
  inRun: InRun,
  workspaceId: string,
  fields: DraftProfileOutput,
  replace: boolean,
  print: Print,
): Promise<number> {
  const body = icpBody.safeParse(fields);
  if (!body.success) {
    print(
      `icp_draft_invalid: ${body.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
    return EXIT.failed;
  }
  const saved = await inRun(async () => {
    // The row locked before the check: a screen save meanwhile is read here, never overwritten.
    await lockedIcpId();
    const icp = await getIcp(workspaceId);
    if (!replace && hasTargeting(icp)) return null;
    return { before: icp.version, after: (await saveIcp(body.data)).version };
  });
  if (saved === null) return notEmpty(workspaceId, print);
  const credits = RESCORE_CREDITS_PER_LEAD;
  print(
    saved.after === saved.before
      ? `icp_saved: version ${saved.after}, the targeting unchanged: no re-score`
      : `icp_saved: version ${saved.after}; icp.updated re-scores the workspace's leads at ${credits} credit a lead`,
  );
  return EXIT.done;
}

function notEmpty(workspaceId: string, print: Print): number {
  print(`icp_not_empty: the ICP of ${workspaceId} has targeting: pass --replace to draft over it`);
  return EXIT.refused;
}

function parse(args: string[]) {
  try {
    const { values } = parseArgs({ args, options: OPTIONS });
    const { workspace, brief } = values;
    const briefFile = values["brief-file"];
    if (workspace === undefined || (brief !== undefined && briefFile !== undefined)) return null;
    const flags = { dryRun: values["dry-run"] === true, replace: values.replace === true };
    return { named: workspace, brief, briefFile, ...flags };
  } catch {
    return null; // an unknown option, a positional, or an option without its value
  }
}

if (import.meta.main) {
  // On Linux, writes to a pipe or a terminal are synchronous: nothing is lost by exiting here, and
  // exiting closes the database clients the commands opened.
  process.exit(await runDraft(process.argv.slice(2), (line) => console.log(line)));
}
