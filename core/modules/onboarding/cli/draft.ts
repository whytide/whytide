// `pnpm knowledge:draft --workspace <id or slug> [--url <https://…>] [--file <path>]... [--accept
// [--replace-edited]]` (README "The script"): an engineer drafts a workspace's Company Knowledge from
// its website and up to five of its documents. The script never calls a model: it reads the files,
// then starts the Draft the Company screen starts (the website saved first with --url), its documents
// with it, and waits for the worker's run, reading the record every two seconds, twenty minutes at
// most. Then it prints the pages and documents read and each drafted field, accepts the draft with
// --accept, or says where to review it. Each line starts with a code; a refusal writes nothing. No
// line carries a page's or a document's text.
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { type PrismaClient, withTenant } from "@whytide/db";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { findWorkspace, findWorkspaceBySlug } from "@whytide/tenancy";
import { getCompanyKnowledge, lockedRecordId, saveCompanyKnowledge } from "../domain/commands.ts";
import {
  type DraftState,
  draftState,
  listCompanyDocuments,
  listWebsitePages,
  requestDraft,
} from "../domain/draft.ts";
import { CONTENT_FIELDS } from "../domain/fields.ts";
import { acceptDraft } from "../domain/review.ts";
import { changedFields } from "../domain/rules.ts";
import { errors } from "../errors.ts";
import type { PendingDraft } from "../schemas/draft-company-knowledge.ts";
import { COMPANY_SCREEN, DRAFT_USAGE, EXIT, FIELD_START, WAIT } from "./constants.ts";
import { readDocuments } from "./documents.ts";

export type Print = (line: string) => void;
/** A test's database client and wait; the process's `app` client and WAIT otherwise. */
export type DraftOptions = {
  readonly client?: PrismaClient;
  readonly everyMs?: number;
  readonly forMs?: number;
};
type Tenant = <T>(fn: () => Promise<T>) => Promise<T>;

const OPTIONS = {
  workspace: { type: "string" },
  url: { type: "string" },
  file: { type: "string", multiple: true },
  accept: { type: "boolean" },
  "replace-edited": { type: "boolean" },
} as const;

/** The command with its arguments; the exit code is one of EXIT. */
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
  const { named, url, files, accept, replaceEdited } = parsed;
  // pnpm runs the script in the module's folder; a path is the caller's, from where pnpm started.
  const read = await readDocuments(files, process.env.INIT_CWD ?? process.cwd());
  if (!read.ok) {
    print(`${read.code}: ${read.file}`);
    return EXIT.refused;
  }
  try {
    // An id has an underscore and a slug none (tenancy's docs/concepts.md). The workspace is found
    // first: a mistyped id writes no record and starts no Draft.
    const byId = named.includes("_");
    const workspace = await (byId ? findWorkspace(named) : findWorkspaceBySlug(named));
    if (workspace === null) {
      print(
        byId
          ? `workspace_not_found: no workspace has the id ${named}`
          : `workspace_not_found: no single workspace has the slug ${named}: pass its id`,
      );
      return EXIT.notFound;
    }
    const workspaceId = workspace.id;
    const principal = servicePrincipal("onboarding");
    const tenant: Tenant = (fn) =>
      withTenant({ workspaceId, principal }, fn, { client: options.client });
    // One run: the website saved, the Draft started with its documents, or nothing written.
    const started = await tenant(async () => {
      if (url !== undefined) {
        await saveCompanyKnowledge({ ...(await getCompanyKnowledge(workspaceId)), sourceUrl: url });
      }
      await requestDraft(workspaceId, read.documents);
      return draftState();
    });
    const run = started.draftRunId ?? "";
    if (url !== undefined) print(`website_saved: ${url}`);
    print(`draft_requested: run ${run} in ${workspaceId}, ${files.length} document(s)`);
    const screen = COMPANY_SCREEN.replace("{workspace}", workspaceId);
    const ended = await waitFor(run, tenant, options);
    if (ended === "superseded") {
      print(`draft_superseded: a later Draft replaced run ${run}, which writes nothing`);
      return EXIT.superseded;
    }
    const { fetchStatus, fetchError, pendingDraft, companyKnowledgeId } = ended;
    if (fetchStatus !== "drafted" && fetchStatus !== "failed") {
      const worker = fetchStatus === "fetching" ? "; is the worker running?" : "";
      print(
        `draft_timeout: run ${run} is still ${fetchStatus}: the worker goes on, and the draft shows in the Company screen, ${screen}${worker}`,
      );
      return EXIT.timeout;
    }
    const pages = await tenant(() => listWebsitePages(companyKnowledgeId));
    const documents = await tenant(() => listCompanyDocuments(companyKnowledgeId));
    for (const page of pages) print(`page: ${page.url} (${page.status})`);
    for (const document of documents) print(`document: ${document.name} (${document.status})`);
    if (fetchStatus === "failed") {
      print(`draft_failed: ${fetchError}`);
      return EXIT.failed;
    }
    // Accepted or discarded on the Company screen meanwhile.
    if (pendingDraft === null) {
      print(`${errors.company_knowledge_no_draft}: ${workspaceId}`);
      return EXIT.refused;
    }
    for (const line of fieldLines(pendingDraft)) print(line);
    if (!accept) {
      print(`draft_ready: review it in the Company screen, ${screen}`);
      return EXIT.done;
    }
    const accepted = await tenant(async () => {
      // The row locked first, so that the draft accepted is this run's.
      await lockedRecordId();
      if ((await draftState()).draftRunId !== run) return null;
      const before = await getCompanyKnowledge(workspaceId);
      const after = await acceptDraft(replaceEdited);
      return { changed: changedFields(before, after), version: after.version };
    });
    if (accepted === null) {
      print(`draft_superseded: a later Draft replaced run ${run}, which writes nothing`);
      return EXIT.superseded;
    }
    const written =
      accepted.changed.join(", ") || "no field (a person's stays without --replace-edited)";
    print(`draft_accepted: ${written} written, version ${accepted.version}`);
    return EXIT.done;
  } catch (error) {
    if (!isAppError(error) || error.status >= 500) throw error;
    const subject = error.code === errors.company_knowledge_invalid_url ? url : named;
    print(`${error.code}: ${subject}`);
    return EXIT.refused;
  }
}

/** The run's state once it ends, `superseded` once a later Draft started, or the last one read. */
async function waitFor(
  run: string,
  tenant: Tenant,
  options: DraftOptions,
): Promise<DraftState | "superseded"> {
  const { everyMs = WAIT.everyMs, forMs = WAIT.forMs } = options;
  const deadline = Date.now() + forMs;
  for (;;) {
    // Each read is a short run of its own: the worker's runs write in between.
    const state = await tenant(() => draftState());
    if (state.draftRunId !== run) return "superseded";
    if (state.fetchStatus === "drafted" || state.fetchStatus === "failed") return state;
    if (Date.now() >= deadline) return state;
    await sleep(everyMs);
  }
}

/** Each drafted field on a line: a text field's start, a list's count; no control character. */
function fieldLines(draft: PendingDraft): string[] {
  return CONTENT_FIELDS.flatMap((field) => {
    const value = draft.fields[field];
    if (value === null || (Array.isArray(value) && value.length === 0)) return [];
    if (Array.isArray(value)) return [`field ${field}: ${value.length} item(s)`];
    const chars = Array.from(value.text.replace(/\p{Cc}+/gu, " ").trim());
    const start = chars.slice(0, FIELD_START).join("");
    return [`field ${field}: ${start}${chars.length > FIELD_START ? "…" : ""}`];
  });
}

function parse(args: string[]) {
  try {
    const { values } = parseArgs({ args, options: OPTIONS });
    const { workspace, url, file = [], accept = false } = values;
    const replaceEdited = values["replace-edited"] ?? false;
    if (workspace === undefined || (replaceEdited && !accept)) return null;
    return { named: workspace, url, files: file, accept, replaceEdited };
  } catch {
    return null; // an unknown option, a positional, or an option without its value
  }
}

if (import.meta.main) {
  // Exiting closes the database clients the command opened; console.log to a pipe is synchronous.
  process.exit(await runDraft(process.argv.slice(2), (line) => console.log(line)));
}
