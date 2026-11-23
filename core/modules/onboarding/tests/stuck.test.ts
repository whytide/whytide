// When a Draft's run is stuck (draft-full-text; README "The screen", "The prompt at sign-in", "The
// script"): the screens' rule and the script's wait outlast the run's fetch and a drafter's attempt,
// which the workflow's timeouts bound, so that a draft still working is never offered Try again; the
// ICP's line keeps its ten minutes from the Company Knowledge's save. No database, no model.
import assert from "node:assert/strict";
import test from "node:test";
import { WAIT } from "../cli/constants.ts";
import { DRAFT_RUN_MS } from "../domain/constants.ts";
import { STUCK_MS } from "../ui/company/constants.ts";
import { ICP_STUCK_MS } from "../ui/get-started/constants.ts";
import { outcomeOf, stageOf } from "../ui/get-started/progress.ts";
import { DRAFT_TIMEOUTS } from "../workflows/constants.ts";

const MINUTE_MS = 60_000;
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE_MS).toISOString();

test("a run is called stuck, and the script stops waiting, only after its fetch and a drafter's attempt could both have ended: twenty minutes", () => {
  assert.equal(DRAFT_TIMEOUTS.fetch, DRAFT_RUN_MS.fetch);
  assert.equal(DRAFT_TIMEOUTS.draft, DRAFT_RUN_MS.draft);
  assert.ok(DRAFT_RUN_MS.stuck > DRAFT_RUN_MS.fetch + DRAFT_RUN_MS.draft);
  assert.equal(STUCK_MS, DRAFT_RUN_MS.stuck);
  assert.equal(WAIT.forMs, DRAFT_RUN_MS.stuck);
  assert.equal(DRAFT_RUN_MS.stuck, 20 * MINUTE_MS);
});

test("the prompt's run: drafting for nineteen minutes is still running, for twenty-one stuck; the ICP's line is stuck ten minutes after the Company Knowledge's save", () => {
  type Knowledge = Parameters<typeof stageOf>[0];
  const drafting = (minutes: number) =>
    ({ fetchStatus: "fetched", updatedAt: ago(minutes) }) as unknown as Knowledge;
  assert.equal(stageOf(drafting(19), true, NOW), "running");
  assert.equal(stageOf(drafting(21), true, NOW), "stuck");

  assert.equal(ICP_STUCK_MS, 10 * MINUTE_MS);
  const start = { set: false, updatedAt: ago(40) };
  const icp = (minutes: number) =>
    [start, undefined, { status: "drafting" }, ago(minutes)] as const;
  assert.equal(outcomeOf(...icp(9), NOW), "waiting");
  assert.equal(outcomeOf(...icp(11), NOW), "stuck");
});
