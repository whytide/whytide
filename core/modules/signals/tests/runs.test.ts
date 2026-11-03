// A run's rules (alpha-p8-020; README.md "Runs"): the price's rounding and the page estimate, the cut
// from the watermark or the lookback, and post_engagers' reading of a page file, the engagers from the
// cut on. The run itself is the worker's test: core/apps/worker/tests/signals-run.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { blocksOf, cutOf } from "../domain/runs.ts";
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
