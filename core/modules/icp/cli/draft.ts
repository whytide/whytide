// `pnpm icp:draft --workspace <id or slug> [--icp <id>] [--brief <text> | --brief-file <path>]
// [--dry-run] [--replace]` (README "The script"): an engineer drafts the workspace's ICP, its default
// audience, or the audience --icp names, from its Company Knowledge and the admin's brief. The script
// calls no model: it requests a draft, which the worker's icp_draft_profile makes, reads the audience
// every two seconds until the draft ends, prints the proposal and, unless --dry-run, saves it as the
// ICP screen's Use this draft does (acceptDraft). Each line starts with a code or a field's name;
// none carries the brief or the company's text.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { type PrismaClient, withTenant } from "@whytide/db";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { findWorkspace, findWorkspaceBySlug } from "@whytide/tenancy";
import { findAudience, getIcp, lockedIcpId } from "../domain/commands.ts";
import { DRAFT_POLL_MS, DRAFT_TIMEOUT_MS } from "../domain/constants.ts";
import { acceptDraft, type IcpDraft, readDraft, requestDraft } from "../domain/draft.ts";
import { hasTargeting } from "../domain/rules.ts";
import { draftErrors, errors } from "../errors.ts";
import { DRAFT_USAGE, EXIT, PROPOSAL_FIELDS, RESCORE_CREDITS_PER_LEAD } from "./constants.ts";

export type Print = (line: string) => void;
/** For tests: the database client, the reads' interval and time limit, the wait between two reads. */
export type DraftOptions = {
  readonly client?: PrismaClient;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly wait?: (ms: number) => Promise<unknown>;
};
type InRun = <T>(fn: () => Promise<T>) => Promise<T>;
/** What the save needs of the request: the workspace, the audience, the script's run, --replace. */
type SaveRun = {
  readonly workspaceId: string;
  readonly icpId: string | undefined;
  readonly draftRunId: string;
  readonly replace: boolean;
};

const OPTIONS = {
  workspace: { type: "string" },
  icp: { type: "string" },
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
  const { named, icpId, briefFile, replace } = parsed;
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
      !replace && hasTargeting(await getIcp(workspaceId, icpId))
        ? null
        : requestDraft(workspaceId, brief, icpId),
    );
    if (draftRunId === null) return notEmpty({ workspaceId, icpId }, print);
    print(`icp_draft_requested: ${draftRunId} in ${workspaceId}${ofAudience(icpId)}`);
    const draft = await awaitDraft(inRun, { draftRunId, icpId }, options);
    if (draft === null) {
      const seconds = (options.timeoutMs ?? DRAFT_TIMEOUT_MS) / 1000;
      print(`icp_draft_timed_out: no draft after ${seconds} seconds: is the worker running?`);
      return EXIT.timedOut;
    }
    if (draft.draftRunId === null) {
      // An accept or a discard ends a draft and clears its run (domain/draft.ts): the screen's.
      print(`icp_draft_ended: the draft of ${draftRunId} was used or discarded on the ICP screen`);
      return EXIT.ended;
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
    return await save(inRun, { workspaceId, icpId, draftRunId, replace }, print);
  } catch (error) {
    if (!isAppError(error) || error.status >= 500) throw error;
    // An --icp the workspace does not hold names the audience; any other refusal the workspace.
    print(`${error.code}: ${error.code === errors.icp_not_found ? icpId : named}`);
    return EXIT.refused;
  }
}

/** The draft once it ended or a later request's run replaced it; null when the time ran out. */
async function awaitDraft(
  inRun: InRun,
  { draftRunId, icpId }: { readonly draftRunId: string; readonly icpId: string | undefined },
  options: DraftOptions,
): Promise<IcpDraft | null> {
  const deadline = Date.now() + (options.timeoutMs ?? DRAFT_TIMEOUT_MS);
  const wait = options.wait ?? sleep;
  for (;;) {
    // Each read its own short run: a run holds a connection for five seconds at most.
    const draft = await inRun(() => readDraft(icpId));
    const ended = draft.status === "drafted" || draft.status === "failed";
    if (draft.draftRunId !== draftRunId || ended) return draft;
    if (Date.now() >= deadline) return null;
    await wait(options.pollMs ?? DRAFT_POLL_MS);
  }
}

/**
 * Saves the proposal of the script's run as the screen's Use this draft does (acceptDraft): still the
 * audience's latest, the audience without targeting unless --replace, the proposal within the PUT
 * body's schema; the criteria stay. A targeting change moves the version; the default's icp.updated
 * re-scores the workspace's leads, another audience's change re-scores none.
 */
async function save(inRun: InRun, run: SaveRun, print: Print): Promise<number> {
  const { workspaceId, icpId, draftRunId, replace } = run;
  let saved: { readonly before: number; readonly after: number; readonly isDefault: boolean };
  try {
    saved = await inRun(async () => {
      // The row locked before the read: a screen save meanwhile is read here, never overwritten.
      const id = await lockedIcpId(icpId);
      const before = (await getIcp(workspaceId, id)).version;
      const after = (await acceptDraft(replace, draftRunId, id)).version;
      return { before, after, isDefault: (await findAudience(id))?.isDefault === true };
    });
  } catch (error) {
    if (!isAppError(error)) throw error;
    if (error.code === draftErrors.icp_not_empty) return notEmpty({ workspaceId, icpId }, print);
    if (error.code !== draftErrors.icp_draft_invalid) throw error;
    const paths = Array.isArray(error.details?.fields) ? error.details.fields : [];
    print(`icp_draft_invalid: ${paths.join(", ")}`);
    return EXIT.failed;
  }
  const credits = RESCORE_CREDITS_PER_LEAD;
  print(
    saved.after === saved.before
      ? `icp_saved: version ${saved.after}, the targeting unchanged: no re-score`
      : saved.isDefault
        ? `icp_saved: version ${saved.after}; icp.updated re-scores the workspace's leads at ${credits} credit a lead`
        : `icp_saved: version ${saved.after} of ${icpId}; not the default audience: no re-score`,
  );
  return EXIT.done;
}

function notEmpty(
  { workspaceId, icpId }: { readonly workspaceId: string; readonly icpId: string | undefined },
  print: Print,
): number {
  const subject = icpId === undefined ? "the ICP" : `the audience ${icpId}`;
  print(
    `icp_not_empty: ${subject} of ${workspaceId} has targeting: pass --replace to draft over it`,
  );
  return EXIT.refused;
}

/** The request's line names an audience --icp gave; the default's stays as before audiences. */
function ofAudience(icpId: string | undefined): string {
  return icpId === undefined ? "" : `, audience ${icpId}`;
}

function parse(args: string[]) {
  try {
    const { values } = parseArgs({ args, options: OPTIONS });
    const { workspace, icp, brief } = values;
    const briefFile = values["brief-file"];
    if (workspace === undefined || (brief !== undefined && briefFile !== undefined)) return null;
    const flags = { dryRun: values["dry-run"] === true, replace: values.replace === true };
    return { named: workspace, icpId: icp, brief, briefFile, ...flags };
  } catch {
    return null; // an unknown option, a positional, or an option without its value
  }
}

if (import.meta.main) {
  // On Linux, writes to a pipe or a terminal are synchronous: nothing is lost by exiting here, and
  // exiting closes the database clients the commands opened.
  process.exit(await runDraft(process.argv.slice(2), (line) => console.log(line)));
}
