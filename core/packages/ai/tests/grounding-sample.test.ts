// The grounding sample end to end (README.md "The grounding sample"), against the worktree's
// database and the files port's fake: two sources as qualification's and messaging's define them,
// thirty why bullets and thirty drafts in the week and some outside it, all made up. The sheet
// holds twenty of each with their facts and sources; a second draw of the week gives the same; a
// record writes the row, and a second one replaces it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { filesPort, getAdapter } from "@whytide/providers";
import {
  defineGroundingSource,
  drawGroundingSample,
  type GroundingKind,
  recordGroundingSample,
} from "../index.ts";

withTestDb();
const app = asRole("app");
const files = await getAdapter(filesPort, "fake");
const tenant = { workspaceId: "wsp_groundinga", principal: servicePrincipal("test") };
const WEEK = "2026-W43";
const inWeek = new Date("2026-10-21T10:00:00.000Z").getTime();

/** Thirty texts of the kind made in the week, two the week after; each fact cites its record. */
function sourceOf(kind: GroundingKind, prefix: string) {
  const made = Array.from({ length: 32 }, (_, i) => ({
    ref: `${prefix}_${String(i).padStart(2, "0")}`,
    at: inWeek + (i < 30 ? i : 7 * 24 + i) * 3_600_000,
  }));
  return defineGroundingSource({
    kind,
    async list(_, week) {
      return made
        .filter(({ at }) => at >= week.from.getTime() && at < week.to.getTime())
        .map((m) => m.ref);
    },
    async read(_, refs) {
      return refs.map((ref) => ({
        ref,
        text: `=Text of ${ref}, "quoted"`,
        facts: [
          { value: `Fact of ${ref}`, source: `${prefix}s/${ref}/title` },
          { value: "Two\nlines", source: `${prefix}s/${ref}/excerpt` },
        ],
      }));
    },
  });
}

test("a draw without a source refuses with ai_grounding_source_missing", async () => {
  await assert.rejects(drawGroundingSample(tenant, WEEK, { files }), {
    code: "ai_grounding_source_missing",
  });
});

test("the sheet holds twenty why bullets and twenty drafts of the week, each with its facts and sources; a second draw gives the same", async () => {
  sourceOf("why", "ssn");
  sourceOf("draft", "mdr");
  assert.throws(() => sourceOf("why", "ssn"), { code: "ai_grounding_source_duplicate" });

  const first = await drawGroundingSample(tenant, WEEK, { files });
  assert.deepEqual(
    [first.key, first.why, first.drafts],
    ["w/wsp_groundinga/exports/grounding-sample-2026-W43.csv", 20, 20],
  );
  const lines = first.body.split("\r\n");
  assert.equal(lines[0], "﻿kind,ref,text,facts,sources,invented_facts");
  const rows = lines.slice(1, -1);
  assert.equal(rows.length, 40);
  assert.deepEqual([...new Set(rows.map((row) => row.split(",")[0]))], ["why", "draft"]);
  const ref = rows[0]?.split(",")[1] ?? "";
  assert.match(ref, /^ssn_(?:[01]\d|2\d)$/);
  assert.equal(
    rows[0],
    `why,${ref},"'=Text of ${ref}, ""quoted""","Fact of ${ref}\nTwo lines","ssns/${ref}/title\nssns/${ref}/excerpt",`,
  );
  assert.ok(
    rows.every((row) => !/_3[01],/.test(row)),
    "none from the week after",
  );

  const second = await drawGroundingSample(tenant, WEEK, { files });
  assert.equal(second.body, first.body);
  const stored = await files.list({ workspaceId: tenant.workspaceId, prefix: "exports/" });
  assert.deepEqual(
    stored.files.map((file) => file.key),
    [first.key],
  );
  const other = await drawGroundingSample(tenant, "2026-W44", { files });
  assert.deepEqual([other.why, other.drafts], [2, 2]);
});

test("--record 0 writes the week's row with the sample's counts; a second record replaces it", async () => {
  const input = { week: WEEK, invented: 0, reviewedBy: "usr_reviewer" };
  const row = await recordGroundingSample(tenant, input, { client: app });
  assert.match(row.id, /^gsm_/);
  const again = await recordGroundingSample(tenant, { ...input, invented: 2 }, { client: app });
  const rows = await app.groundingSample.findMany();
  assert.equal(rows.length, 1);
  const { id, workspaceId, week, whyCount, draftCount, inventedFacts, reviewedBy } = rows[0] ?? {};
  assert.deepEqual([inventedFacts, reviewedBy], [2, "usr_reviewer"]);
  assert.deepEqual(
    { id, workspaceId, week, whyCount, draftCount },
    { id: row.id, workspaceId: tenant.workspaceId, week: WEEK, whyCount: 20, draftCount: 20 },
  );
  assert.equal(again.id, row.id);
  for (const wrong of [
    { invented: -1 },
    { invented: 1.5 },
    { reviewedBy: "" },
    { week: "2026-W99" },
  ]) {
    await assert.rejects(recordGroundingSample(tenant, { ...input, ...wrong }, { client: app }), {
      code: "ai_grounding_input_invalid",
    });
  }
});
