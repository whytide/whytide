// `pnpm grounding-sample --workspace <id or slug> --week <ISO week> [--record <invented facts>
// --reviewer <email>]` (@whytide/ai's README "The grounding sample"): an engineer draws the
// workspace's weekly sample of why bullets and drafts into its exports/, then records what the
// reviewer found. It loads every module's build, as the hosts do, so that each module defines its
// source; tenancy's reads come from its loaded index. The line starts with a code:
// grounding_sample_written, grounding_sample_recorded, or the refusal's; it holds no text or email.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { drawGroundingSample, recordGroundingSample } from "@whytide/ai";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { listModules } from "./modules-generate.ts";

const USAGE =
  "usage: pnpm grounding-sample --workspace <id or slug> --week <ISO week> [--record <invented facts> --reviewer <email>]";

/** What the command reads of tenancy, from its loaded index. */
export type Tenancy = {
  readonly findWorkspaceBySlug: (slug: string) => Promise<{ readonly id: string } | null>;
  readonly findUserByEmail: (email: string) => Promise<{ readonly id: string } | null>;
};
export type SampleDeps = {
  readonly tenancy: Tenancy;
  readonly draw: typeof drawGroundingSample;
  readonly record: typeof recordGroundingSample;
};

/** The command with its arguments; the exit code: 0 done, 1 refused, 2 a usage error. */
export async function runGroundingSample(
  args: string[],
  print: (line: string) => void,
  deps: SampleDeps,
): Promise<number> {
  const text = { type: "string" } as const;
  const options = { workspace: text, week: text, record: text, reviewer: text };
  let values: { workspace?: string; week?: string; record?: string; reviewer?: string } = {};
  try {
    ({ values } = parseArgs({ args, options }));
  } catch {
    // an unknown option, or one without its value: the usage below
  }
  const { workspace: named, week, record, reviewer } = values;
  const recording = record !== undefined || reviewer !== undefined;
  if (!named || !week || (recording && !(/^\d+$/.test(record ?? "") && reviewer))) {
    print(USAGE);
    return 2;
  }
  try {
    // An id has an underscore and a slug none (tenancy's docs/concepts.md).
    const workspaceId = named.includes("_")
      ? named
      : (await deps.tenancy.findWorkspaceBySlug(named))?.id;
    if (workspaceId === undefined) {
      print(`workspace_not_found: no single workspace has the slug ${named}: pass its id`);
      return 1;
    }
    const tenant = { workspaceId, principal: servicePrincipal("ai") };
    if (!recording) {
      const { key, why, drafts } = await deps.draw(tenant, week);
      print(`grounding_sample_written: ${key}, ${why} why bullets, ${drafts} drafts`);
      return 0;
    }
    const user = await deps.tenancy.findUserByEmail(reviewer ?? "");
    if (user === null) {
      print("user_not_found: no user has the reviewer's email");
      return 1;
    }
    const input = { week, invented: Number(record), reviewedBy: user.id };
    const { inventedFacts, whyCount, draftCount } = await deps.record(tenant, input);
    const sample = `${whyCount} why bullets and ${draftCount} drafts`;
    print(
      `grounding_sample_recorded: ${workspaceId} ${week}, ${inventedFacts} invented in ${sample}`,
    );
    return 0;
  } catch (error) {
    if (!isAppError(error) || error.status >= 500) throw error;
    print(`${error.code}: ${named} ${week}`);
    return 1;
  }
}

if (import.meta.main) {
  const modules = join(import.meta.dirname, "..", "..", "..", "modules");
  const loaded = new Map<string, unknown>();
  for (const name of listModules(modules)) {
    const index = join(modules, name, "dist", "index.js");
    if (existsSync(index)) loaded.set(name, await import(pathToFileURL(index).href));
  }
  const deps = {
    tenancy: loaded.get("tenancy") as Tenancy,
    draw: drawGroundingSample,
    record: recordGroundingSample,
  };
  // Exiting closes the database clients the command opened; console.log to a pipe is synchronous.
  process.exit(await runGroundingSample(process.argv.slice(2), (line) => console.log(line), deps));
}
