// A source's next fire times (alpha-p8-040; README.md "API"): its kind's schedule from the save, after
// its last run, the next one first; none while it is disabled or when its kind is not registered.
import assert from "node:assert/strict";
import test from "node:test";
import { fireTimes } from "../domain/fire-times.ts";

const source = {
  kind: "post_engagers",
  config: { postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000" },
  createdAt: new Date("2026-10-22T09:30:00.000Z"),
  enabled: true,
  lastRunAt: null,
};
const iso = (times: readonly Date[]) => times.map((at) => at.toISOString());
const NONE = { fireTimes: [], nextRunAt: null };

test("the next fire times: the kind's three before the first run, those after the last run since; none while disabled or of an unknown kind", () => {
  const fresh = fireTimes(source);
  assert.deepEqual(iso(fresh.fireTimes), [
    "2026-10-22T09:30:00.000Z",
    "2026-10-25T09:30:00.000Z",
    "2026-10-29T09:30:00.000Z",
  ]);
  assert.equal(fresh.nextRunAt?.toISOString(), "2026-10-22T09:30:00.000Z");
  const ranAtSave = fireTimes({ ...source, lastRunAt: new Date("2026-10-22T09:30:05.000Z") });
  assert.deepEqual(iso(ranAtSave.fireTimes), [
    "2026-10-25T09:30:00.000Z",
    "2026-10-29T09:30:00.000Z",
  ]);
  assert.equal(ranAtSave.nextRunAt?.toISOString(), "2026-10-25T09:30:00.000Z");
  assert.deepEqual(fireTimes({ ...source, lastRunAt: new Date("2026-10-29T10:00:00.000Z") }), NONE);
  assert.deepEqual(fireTimes({ ...source, enabled: false }), NONE);
  assert.deepEqual(fireTimes({ ...source, kind: "job_board" }), NONE);
});
