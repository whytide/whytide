// The counts' periods (README.md "Routes"; domain/counts.ts periodStarts), pure: today from the start
// of the sender account's local day, the last 7 days from the start of the local day six days before
// it, in three zones: Asia/Kolkata, which keeps one offset, and America/Los_Angeles and
// Pacific/Auckland across their daylight-saving changes, where those six days hold an hour more or
// an hour less than six times 24.
import assert from "node:assert/strict";
import { test } from "node:test";
import { periodStarts } from "../domain/counts.ts";

const starts = (at: string, zone: string) => {
  const { today, last7Days } = periodStarts(new Date(at), zone);
  return { today: today.toISOString(), last7Days: last7Days.toISOString() };
};

test("Asia/Kolkata, UTC+05:30: today from the local midnight, the last 7 days from the one six days before; a second before midnight is the day before", () => {
  // 01:30 on 30 October in Kolkata.
  assert.deepEqual(starts("2026-10-29T20:00:00.000Z", "Asia/Kolkata"), {
    today: "2026-10-29T18:30:00.000Z",
    last7Days: "2026-10-23T18:30:00.000Z",
  });
  // 23:59:59 on 29 October, and 00:00 on 30 October: the midnight starts the new day.
  assert.deepEqual(starts("2026-10-29T18:29:59.000Z", "Asia/Kolkata"), {
    today: "2026-10-28T18:30:00.000Z",
    last7Days: "2026-10-22T18:30:00.000Z",
  });
  assert.deepEqual(starts("2026-10-29T18:30:00.000Z", "Asia/Kolkata"), {
    today: "2026-10-29T18:30:00.000Z",
    last7Days: "2026-10-23T18:30:00.000Z",
  });
});

test("the six days before today cross a month and a year in the local calendar", () => {
  // 09:00 on 2 January 2027 in Kolkata: from 27 December 2026.
  assert.deepEqual(starts("2027-01-02T03:30:00.000Z", "Asia/Kolkata"), {
    today: "2027-01-01T18:30:00.000Z",
    last7Days: "2026-12-26T18:30:00.000Z",
  });
});

test("America/Los_Angeles across the fall-back of 1 November 2026: today at PST's midnight, the last 7 days from PDT's, an hour more than six days of 24", () => {
  // 12:00 on 3 November, PST (UTC-8); 28 October was PDT (UTC-7).
  assert.deepEqual(starts("2026-11-03T20:00:00.000Z", "America/Los_Angeles"), {
    today: "2026-11-03T08:00:00.000Z",
    last7Days: "2026-10-28T07:00:00.000Z",
  });
  // 23:30 on 31 October, PDT, the evening before the change: both midnights PDT's.
  assert.deepEqual(starts("2026-11-01T06:30:00.000Z", "America/Los_Angeles"), {
    today: "2026-10-31T07:00:00.000Z",
    last7Days: "2026-10-25T07:00:00.000Z",
  });
});

test("Pacific/Auckland across the spring-forward of 27 September 2026: today at NZDT's midnight, the last 7 days from NZST's, an hour short of six days of 24", () => {
  // 13:00 on 30 September, NZDT (UTC+13); 24 September was NZST (UTC+12).
  assert.deepEqual(starts("2026-09-30T00:00:00.000Z", "Pacific/Auckland"), {
    today: "2026-09-29T11:00:00.000Z",
    last7Days: "2026-09-23T12:00:00.000Z",
  });
});

test("the same instant is today in one zone and yesterday in another: each sender's periods are its own zone's", () => {
  // 02:00 UTC on 30 October: 07:30 on the 30th in Kolkata, 19:00 on the 29th in Los Angeles.
  const at = "2026-10-30T02:00:00.000Z";
  assert.equal(starts(at, "Asia/Kolkata").today, "2026-10-29T18:30:00.000Z");
  assert.equal(starts(at, "America/Los_Angeles").today, "2026-10-29T07:00:00.000Z");
  assert.equal(starts(at, "UTC").today, "2026-10-30T00:00:00.000Z");
});
