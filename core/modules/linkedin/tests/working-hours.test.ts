// The working-hours rules (domain/working-hours.ts), the business logic of acceptance criterion 4:
// start after end, a day outside 1 to 7, a repeated day and no day at all are working_hours_invalid,
// naming the field; valid hours come back with their days sorted.
import assert from "node:assert/strict";
import test from "node:test";
import { isAppError } from "@whytide/platform";
import { parseTimeZone, parseWorkingHours } from "../domain/working-hours.ts";

const refusal = (fields: string[]) => (error: unknown) =>
  isAppError(error) &&
  error.code === "working_hours_invalid" &&
  JSON.stringify(error.details?.fields) === JSON.stringify(fields);

test("working hours: start before end, days distinct from 1 to 7, a zone Intl knows", () => {
  const valid = { start: "08:30", end: "18:00", days: [5, 1, 3] };
  assert.deepEqual(parseWorkingHours(valid), { start: "08:30", end: "18:00", days: [1, 3, 5] });
  const days = ["workingHours.days"];
  assert.throws(
    () => parseWorkingHours({ ...valid, start: "18:00", end: "08:30" }),
    refusal(["workingHours.end"]),
  );
  assert.throws(
    () => parseWorkingHours({ ...valid, start: "09:00", end: "09:00" }),
    refusal(["workingHours.end"]),
  );
  assert.throws(() => parseWorkingHours({ ...valid, days: [0, 1] }), refusal(days));
  assert.throws(() => parseWorkingHours({ ...valid, days: [1, 8] }), refusal(days));
  assert.throws(() => parseWorkingHours({ ...valid, days: [2, 2] }), refusal(days));
  assert.throws(() => parseWorkingHours({ ...valid, days: [] }), refusal(days));
  assert.throws(
    () => parseWorkingHours({ ...valid, start: "8:30", end: "24:00" }),
    refusal(["workingHours.start", "workingHours.end"]),
  );
  assert.equal(parseTimeZone("Pacific/Auckland"), "Pacific/Auckland");
  assert.throws(() => parseTimeZone("Mars/Olympus_Mons"), refusal(["timeZone"]));
});
