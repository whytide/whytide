// The read budget's arithmetic (gamma-p5-040, gamma-p5-045; README.md "Runs"): a run's share of its
// account's reads left today, the send path's 20 kept, by group (each agent with a due source, and
// the due sources in no agent), then within its group, for 1 to 10 sources, none left and fewer than
// 20 left; the page reads a budget allows.
import assert from "node:assert/strict";
import test from "node:test";
import { READS_KEPT } from "../domain/schedule/constants.ts";
import { type Groups, pageLimitOf, shareOf } from "../domain/schedule/share.ts";

/** `sources` due sources in one group, as before the agents. */
const alone = (sources: number) => ({ groups: 1, inGroup: sources });
/** The reads kept unset, SIGNALS_READS_KEPT_FOR_SENDS's default, which the daily runs pass. */
const KEPT = READS_KEPT.default;
const share = (left: number, groups: Groups) => shareOf(left, groups, KEPT);

test("the reads left less the 20 kept, shared by 1 to 10 sources of one group and rounded down; what the shares leave is never below the 20", () => {
  assert.equal(KEPT, 20);
  const shares = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((sources) => share(100, alone(sources)));
  assert.deepEqual(shares, [80, 40, 26, 20, 16, 13, 11, 10, 8, 8]);
  for (const [n, share] of shares.entries()) assert.ok(100 - share * (n + 1) >= 20);
  // gamma-p5-040's case: three sources and 62 reads left get 14 each and leave 20.
  assert.equal(share(62, alone(3)), 14);
  assert.equal(share(21, alone(1)), 1);
});

test("the groups share evenly, then each group's sources: one due source in agent A and three in agent B, with 62 reads left, give A's run 21 and each of B's 7", () => {
  assert.equal(share(62, { groups: 2, inGroup: 1 }), 21);
  assert.equal(share(62, { groups: 2, inGroup: 3 }), 7);
  // Three agents and the sources in no agent, 10 due in each: 100 reads left give 2 each.
  assert.equal(share(100, { groups: 4, inGroup: 10 }), 2);
  // A group's sources share its part only: one source in no agent beside nine in one agent.
  assert.deepEqual(
    [1, 9].map((inGroup) => share(100, { groups: 2, inGroup })),
    [40, 4],
  );
});

test("protective rule, beta's read limits: whatever the groups and their sources, the budgets of all the due sources never pass the reads left less the 20 kept", () => {
  for (const left of [0, 19, 20, 21, 62, 100, 137, 500]) {
    for (const sizes of [[1], [3], [1, 3], [10, 10, 10, 10], [1, 2, 7], [10, 1, 1, 4]]) {
      const groups = sizes.length;
      const total = sizes.reduce(
        (sum, inGroup) => sum + inGroup * share(left, { groups, inGroup }),
        0,
      );
      assert.ok(total <= Math.max(left - KEPT, 0), `${left} reads, ${sizes}: ${total}`);
      for (const inGroup of sizes) {
        assert.ok(share(left, { groups, inGroup }) <= Math.max(left - KEPT, 0));
      }
    }
  }
});

test("no read left, or 20 and fewer, gives no budget, never a negative one; no group or no source counts as one", () => {
  assert.deepEqual(
    [0, 1, 10].map((sources) => share(0, alone(sources))),
    [0, 0, 0],
  );
  assert.deepEqual(
    [19, 20].map((left) => share(left, { groups: 3, inGroup: 2 })),
    [0, 0],
  );
  assert.equal(share(25, { groups: 0, inGroup: 0 }), share(25, alone(1)));
});

test("a run's page reads take half its budget at most, rounded down, and one at least: the rest is its profiles'", () => {
  assert.deepEqual([0, 1, 2, 3, 5, 6, 14, 80].map(pageLimitOf), [1, 1, 1, 1, 2, 3, 7, 40]);
});

test("the reads kept are the caller's, SIGNALS_READS_KEPT_FOR_SENDS: 30 kept, 62 reads left in three sources give 10 each, 31 left one, 30 none", () => {
  assert.deepEqual(
    [62, 31, 30].map((left) => shareOf(left, alone(left === 62 ? 3 : 1), 30)),
    [10, 1, 0],
  );
  assert.equal(shareOf(100, { groups: 2, inGroup: 1 }, 30), 35);
});
