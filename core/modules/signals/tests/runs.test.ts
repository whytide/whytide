// A run's rules (alpha-p8-020; README.md "Runs"): the price's rounding and the page estimate, the cut
// from the watermark or the lookback, and post_engagers' reading of a page file, the engagers from the
// cut on. The price per engager (beta-p1-090): its credits from SIGNALS_CREDITS_PER_ENGAGER within its
// bounds, read in a process of their own; a candidate's credit, its key, subject, commit or release,
// on a credits client that records its calls. The run itself is the worker's test:
// core/apps/worker/tests/signals-run.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  AppError,
  bindCreditsClient,
  type CreditsClient,
  creditsCodes,
  type ReserveInput,
  registeredPrices,
} from "@whytide/platform";
import {
  blocksOf,
  cutOf,
  reserveCredits,
  reserveEngagerCredit,
  settleEngagerCredit,
} from "../domain/runs.ts";
import { prices } from "../prices.ts";
import { settings } from "../settings.ts";
import { PAGE_SIZE, pageOf } from "../sources/post_engagers/index.ts";

const POST = "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000";
const engager = (n: number, engagedAt: string, more: Record<string, string> = {}) => ({
  providerMemberRef: `member-${n}`,
  profileUrl: `https://www.linkedin.com/in/member-${n}`,
  name: `Member ${n}`,
  headline: "Head of sales",
  reaction: "like",
  engagedAt,
  ...more,
});

test("engagers are priced by 30, rounded up; a run reserves SIGNALS_ESTIMATED_PAGES pages, 100 engagers, 4 credits", () => {
  assert.equal(prices["signals.engager_read"], "signals.engager_read");
  assert.deepEqual([0, 1, 30, 31, 95, 100].map(blocksOf), [0, 1, 1, 2, 4, 4]);
  assert.deepEqual([settings.SIGNALS_ESTIMATED_PAGES, PAGE_SIZE], [4, 25]);
  assert.equal(blocksOf(settings.SIGNALS_ESTIMATED_PAGES * PAGE_SIZE), 4);
});

test("the cut is the watermark's engagedAt, or the lookback's start when that is later or there is none", () => {
  const now = new Date("2026-10-22T12:00:00.000Z");
  const lookback = "2026-09-22T12:00:00.000Z";
  const cut = (watermark: unknown) => cutOf(watermark, 30, now).toISOString();
  assert.equal(cut(null), lookback);
  assert.equal(cut({ engagedAt: "2026-10-20T08:00:00.000Z" }), "2026-10-20T08:00:00.000Z");
  assert.equal(cut({ engagedAt: "2026-01-01T00:00:00.000Z" }), lookback);
  assert.equal(cut({ engagedAt: "not a date" }), lookback);
});

test("a page file's engagers at the cut or after it are its candidates, of the post; one before it reaches it; a field off the file's schema is refused", () => {
  const comment = { reaction: "comment", commentText: "Useful, thanks" };
  const file = {
    engagers: [
      engager(1, "2026-10-21T10:00:00.000Z", comment),
      engager(2, "2026-10-20T10:00:00.000Z"),
      engager(3, "2026-10-19T10:00:00.000Z"),
    ],
  };
  const page = pageOf(file, { postUrl: POST }, new Date("2026-10-20T10:00:00.000Z"));
  const { engagedAt: _at, ...first } = engager(1, "", comment);
  const { engagedAt: _cut, ...second } = engager(2, "");
  const at = (day: number) => new Date(`2026-10-${day}T10:00:00.000Z`);
  assert.deepEqual(page, {
    candidates: [
      { ...first, engagedAt: at(21), objectUrl: POST },
      { ...second, engagedAt: at(20), objectUrl: POST },
    ],
    reachedCut: true,
  });
  const all = pageOf(file, { postUrl: POST }, new Date(0));
  assert.deepEqual([all.candidates.length, all.reachedCut], [3, false]);
  const extra = { engagers: [engager(4, "2026-10-21T10:00:00.000Z", { email: "a@example.com" })] };
  assert.throws(() => pageOf(extra, { postUrl: POST }, new Date(0)));
});

test("an engager's profile read is priced by signals.engager, unit engager, SIGNALS_CREDITS_PER_ENGAGER's credits, 1 by default; signals.engager_read stays declared", () => {
  assert.equal(prices["signals.engager"], "signals.engager");
  const declared = (action: string) => {
    const price = registeredPrices().get(action);
    return price && { action: price.action, credits: price.credits, unit: price.unit };
  };
  assert.deepEqual(declared("signals.engager"), {
    action: "signals.engager",
    credits: 1,
    unit: "engager",
  });
  assert.deepEqual(declared("signals.engager_read"), {
    action: "signals.engager_read",
    credits: 1,
    unit: "engagers_30",
  });
  assert.equal(settings.SIGNALS_CREDITS_PER_ENGAGER, 1);
});

test("SIGNALS_CREDITS_PER_ENGAGER: an integer from 0 to 100, its price's credits; off its bounds, the start stops on config_invalid naming it", () => {
  /** The setting and its price's credits as a process with `value` reads them, or its error. */
  const read = (value: string) => {
    const script = [
      "try {",
      `  const { settings } = await import(${JSON.stringify(new URL("../settings.ts", import.meta.url).href)});`,
      `  await import(${JSON.stringify(new URL("../prices.ts", import.meta.url).href)});`,
      '  const { registeredPrices } = await import("@whytide/platform");',
      '  const { credits } = registeredPrices().get("signals.engager");',
      "  console.log(JSON.stringify([settings.SIGNALS_CREDITS_PER_ENGAGER, credits]));",
      "} catch (error) {",
      "  const names = error.details.variables.map((variable) => variable.split(':')[0]);",
      "  console.log(JSON.stringify([error.code, error.details.block, names]));",
      "}",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: import.meta.dirname,
      env: { APP_ENV: "test", SIGNALS_CREDITS_PER_ENGAGER: value },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  assert.deepEqual(read("2"), [2, 2]);
  assert.deepEqual(read("0"), [0, 0]);
  assert.deepEqual(read("100"), [100, 100]);
  assert.deepEqual(read(""), [1, 1]);
  const invalid = ["config_invalid", "modules/signals", ["SIGNALS_CREDITS_PER_ENGAGER"]];
  for (const value of ["101", "-1", "1.5", "one"]) assert.deepEqual(read(value), invalid, value);
});

/** A credits client recording its calls, bound in place of credits'; `refusal` thrown by reserve. */
function recordingCredits(refusal?: Error): unknown[][] {
  const calls: unknown[][] = [];
  const client: CreditsClient = {
    reserve: async (input: ReserveInput) => {
      calls.push(["reserve", input]);
      if (refusal !== undefined) throw refusal;
      return { usageId: `cus_${calls.length}`, credits: "1" };
    },
    commit: async (usageId: string) => {
      calls.push(["commit", usageId]);
      return { usageId, credits: "1" };
    },
    release: async (usageId: string) => void calls.push(["release", usageId]),
    balance: async () => assert.fail("balance is not a run's"),
    priceOf: async () => assert.fail("priceOf is not a run's"),
  };
  bindCreditsClient(client);
  return calls;
}

test("a candidate's credit: one signals.engager, keyed sigprof:<runId>:<candidateId>:<n>, a later reservation under n + 1, its subject the candidate, on the 24-hour lease; committed when the profile came, released otherwise; a short balance refused, any other error thrown", async () => {
  const ref = { workspaceId: "wsp_runs", sourceId: "src_runs", runId: "run_runs" };
  const calls = recordingCredits();
  assert.deepEqual(await reserveEngagerCredit(ref, "cand_one", 1), { usageId: "cus_1" });
  await settleEngagerCredit("cus_1", false);
  assert.deepEqual(await reserveEngagerCredit(ref, "cand_one", 2), { usageId: "cus_3" });
  await settleEngagerCredit("cus_3", true);
  const reserve = { workspaceId: "wsp_runs", action: "signals.engager", quantity: 1 };
  const of = { subjectRef: "cand_one", lease: "async" };
  assert.deepEqual(calls, [
    ["reserve", { ...reserve, idempotencyKey: "sigprof:run_runs:cand_one:1", ...of }],
    ["release", "cus_1"],
    ["reserve", { ...reserve, idempotencyKey: "sigprof:run_runs:cand_one:2", ...of }],
    ["commit", "cus_3"],
  ]);

  recordingCredits(new AppError(creditsCodes.insufficient_credits));
  const refused = await reserveEngagerCredit(ref, "cand_two", 1);
  assert.deepEqual(refused, { refused: "insufficient_credits" });
  const down = new AppError("usage_not_open");
  recordingCredits(down);
  await assert.rejects(reserveEngagerCredit(ref, "cand_two", 1), down);
});

test("a run started before beta-p1-090 still reserves its blocks: signals.engager_read, sigrun:<runId> then sigrun:<runId>:<n>, the run as subject, paying up to 30 engagers a credit; a short balance refused", async () => {
  const ref = { workspaceId: "wsp_runs", sourceId: "src_runs", runId: "run_runs" };
  const calls = recordingCredits();
  assert.deepEqual(await reserveCredits(ref, 1, 4, 0), { usageId: "cus_1", until: 120 });
  assert.deepEqual(await reserveCredits(ref, 2, 4, 4), { usageId: "cus_2", until: 240 });
  const block = { workspaceId: "wsp_runs", action: "signals.engager_read", quantity: 4 };
  const of = { subjectRef: "run_runs", lease: "async" };
  assert.deepEqual(calls, [
    ["reserve", { ...block, idempotencyKey: "sigrun:run_runs", ...of }],
    ["reserve", { ...block, idempotencyKey: "sigrun:run_runs:2", ...of }],
  ]);
  recordingCredits(new AppError(creditsCodes.insufficient_credits));
  assert.deepEqual(await reserveCredits(ref, 3, 4, 8), { refused: "insufficient_credits" });
});
