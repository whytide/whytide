// `pnpm grounding-sample` (scripts/grounding-sample.ts) with tenancy's reads and the ai package's
// draw and record stubbed: the usage, a slug or an id, the draw's line, the record's with the
// reviewer's user id, and a refusal's code. The draw and the record themselves are the ai package's
// tests; the sources, qualification's and messaging's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "@whytide/platform";
import { runGroundingSample, type SampleDeps } from "../scripts/grounding-sample.ts";

const calls: unknown[][] = [];
const deps: SampleDeps = {
  tenancy: {
    findWorkspaceBySlug: async (slug) => (slug === "acme" ? { id: "wsp_acme" } : null),
    findUserByEmail: async (email) => (email === "rev@acme.example" ? { id: "usr_rev" } : null),
  },
  async draw(tenant, week) {
    calls.push(["draw", tenant.workspaceId, tenant.principal.actorType, week]);
    if (week === "2026-W99") throw new AppError("ai_grounding_input_invalid");
    const key = `w/${tenant.workspaceId}/exports/grounding-sample-${week}.csv`;
    return { key, why: 20, drafts: 17, body: "" };
  },
  async record(tenant, input) {
    calls.push(["record", tenant.workspaceId, input]);
    const counts = { whyCount: 20, draftCount: 17, inventedFacts: input.invented };
    const at = new Date();
    const row = { id: "gsm_1", workspaceId: tenant.workspaceId, week: input.week, ...counts };
    return { ...row, reviewedBy: input.reviewedBy, reviewedAt: at };
  },
};
async function run(...args: string[]) {
  const lines: string[] = [];
  const code = await runGroundingSample(args, (line) => lines.push(line), deps);
  return [code, ...lines];
}

test("usage, the draw by slug, the record by id with the reviewer's user id, and the refusals", async () => {
  const week = ["--week", "2026-W43"];
  for (const args of [
    [],
    ["--workspace", "acme"],
    ["--workspace", "acme", ...week, "--record", "1"],
    ["--workspace", "acme", ...week, "--reviewer", "rev@acme.example"],
    ["--workspace", "acme", ...week, "--record", "-1", "--reviewer", "rev@acme.example"],
    ["--workspace", "acme", ...week, "--record", "one", "--reviewer", "rev@acme.example"],
    ["--workspace", "acme", ...week, "--other"],
  ]) {
    assert.match(String((await run(...args))[1]), /^usage: pnpm grounding-sample /, args.join(" "));
    assert.equal((await run(...args))[0], 2);
  }
  assert.deepEqual(calls, []);

  assert.deepEqual(await run("--workspace", "acme", ...week), [
    0,
    "grounding_sample_written: w/wsp_acme/exports/grounding-sample-2026-W43.csv, 20 why bullets, 17 drafts",
  ]);
  const reviewer = ["--reviewer", "rev@acme.example"];
  assert.deepEqual(await run("--workspace", "wsp_acme", ...week, "--record", "0", ...reviewer), [
    0,
    "grounding_sample_recorded: wsp_acme 2026-W43, 0 invented in 20 why bullets and 17 drafts",
  ]);
  assert.deepEqual(calls, [
    ["draw", "wsp_acme", "service", "2026-W43"],
    ["record", "wsp_acme", { week: "2026-W43", invented: 0, reviewedBy: "usr_rev" }],
  ]);

  assert.deepEqual(await run("--workspace", "other", ...week), [
    1,
    "workspace_not_found: no single workspace has the slug other: pass its id",
  ]);
  const stranger = ["--reviewer", "who@acme.example"];
  assert.deepEqual(await run("--workspace", "acme", ...week, "--record", "2", ...stranger), [
    1,
    "user_not_found: no user has the reviewer's email",
  ]);
  assert.deepEqual(await run("--workspace", "acme", "--week", "2026-W99"), [
    1,
    "ai_grounding_input_invalid: acme 2026-W99",
  ]);
});
