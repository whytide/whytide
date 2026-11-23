// The allowance counter (README "Allowances", domain/usage.ts) on the worktree's database, in this
// file's schema, as `app` on the global client, outside any run: a call counted in the current UTC
// day or month while it stays within the allowance, refused past it with nothing counted, counted
// again from the next period; a spent period refusing every call until it ends; no allowance, no
// limit, by the day; and ten callers at once never passing an allowance of three together.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { markSpent, periodStart, reserveCall } from "../domain/usage.ts";
import { useClock, useEnrichmentClient } from "../testing/index.ts";

withTestDb();
useEnrichmentClient(asRole("app"));
afterEach(() => useClock(undefined));
const SOURCE = "company-data/fake";
const at = (iso: string) => useClock(() => new Date(iso));
const rows = () =>
  asRole("owner").sourceUsage.findMany({
    select: { source: true, periodStart: true, period: true, used: true, spent: true },
    orderBy: [{ source: "asc" }, { periodStart: "asc" }],
  });
const calls = async (
  count: number,
  source: string,
  allowance: Parameters<typeof reserveCall>[1],
) => {
  const answers: boolean[] = [];
  for (let call = 0; call < count; call += 1) answers.push(await reserveCall(source, allowance));
  return answers;
};

test("periodStart: the day, or the month's first day, in UTC", () => {
  const late = new Date("2026-11-30T23:59:59.999Z");
  assert.equal(periodStart(late, "day"), "2026-11-30");
  assert.equal(periodStart(late, "month"), "2026-11-01");
  assert.equal(periodStart(new Date("2026-12-01T00:00:00.000Z"), "month"), "2026-12-01");
});

test("a day's allowance: each call counted while within it, the next refused with nothing counted, and calls again from the next UTC day", async () => {
  const allowance = { calls: 2, per: "day" } as const;
  at("2026-11-13T23:59:00Z");
  assert.deepEqual(await calls(3, SOURCE, allowance), [true, true, false]);
  at("2026-11-14T00:00:00Z");
  assert.deepEqual(await calls(1, SOURCE, allowance), [true]);
  assert.deepEqual(await rows(), [
    { source: SOURCE, periodStart: "2026-11-13", period: "day", used: 2, spent: false },
    { source: SOURCE, periodStart: "2026-11-14", period: "day", used: 1, spent: false },
  ]);
});

test("a month's allowance: counted over the calendar month, again from the next one's first day", async () => {
  const allowance = { calls: 1, per: "month" } as const;
  at("2026-11-01T00:00:00Z");
  assert.deepEqual(await calls(1, SOURCE, allowance), [true]);
  at("2026-11-30T23:59:59Z");
  assert.deepEqual(await calls(1, SOURCE, allowance), [false]);
  at("2026-12-01T00:00:00Z");
  assert.deepEqual(await calls(1, SOURCE, allowance), [true]);
  const months = (await rows()).map(({ periodStart, period, used }) => [periodStart, period, used]);
  assert.deepEqual(months, [
    ["2026-11-01", "month", 1],
    ["2026-12-01", "month", 1],
  ]);
});

test("markSpent: the vendor's word stops the source until its period ends, with calls left or none set; another source goes on", async () => {
  const allowance = { calls: 100, per: "month" } as const;
  at("2026-11-13T10:00:00Z");
  assert.deepEqual(await calls(1, SOURCE, allowance), [true]);
  await markSpent(SOURCE, allowance);
  assert.deepEqual(await calls(1, SOURCE, allowance), [false]);
  assert.deepEqual(await calls(1, "company-data/other", allowance), [true]);
  at("2026-11-30T23:00:00Z");
  assert.deepEqual(await calls(1, SOURCE, allowance), [false]);
  at("2026-12-01T00:00:00Z");
  assert.deepEqual(await calls(1, SOURCE, allowance), [true]);

  // No allowance: by the day; marked spent before any call, the row is made spent.
  at("2026-11-13T10:00:00Z");
  await markSpent("company-data/open", null);
  assert.deepEqual(await calls(1, "company-data/open", null), [false]);
  at("2026-11-14T10:00:00Z");
  assert.deepEqual(await calls(1, "company-data/open", null), [true]);
  const spent = (await rows())
    .filter(({ spent }) => spent)
    .map(({ source, periodStart }) => [source, periodStart]);
  assert.deepEqual(spent, [
    [SOURCE, "2026-11-01"],
    ["company-data/open", "2026-11-13"],
  ]);
});

test("no allowance: every call may go, each counted by the UTC day", async () => {
  at("2026-11-13T10:00:00Z");
  assert.deepEqual(await calls(5, SOURCE, null), [true, true, true, true, true]);
  const [row] = await rows();
  assert.deepEqual(row, {
    source: SOURCE,
    periodStart: "2026-11-13",
    period: "day",
    used: 5,
    spent: false,
  });
});

test("two callers at once never pass the allowance together: ten at once against three calls, three may go", async () => {
  const allowance = { calls: 3, per: "day" } as const;
  at("2026-11-13T10:00:00Z");
  const answers = await Promise.all(
    Array.from({ length: 10 }, () => reserveCall(SOURCE, allowance)),
  );
  assert.equal(answers.filter(Boolean).length, 3);
  const [row] = await rows();
  assert.equal(row?.used, 3);
});
