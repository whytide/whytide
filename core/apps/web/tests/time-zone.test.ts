// The viewer's time zone as the server takes it from its cookie (src/i18n/time-zone.ts; README "The
// shell"; gamma-en-100): a zone Intl knows is given to next-intl, anything else is none, so that a
// cookie the browser wrote never fails a render.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timeZoneOf } from "../src/i18n/time-zone.ts";

test("a zone Intl knows is taken; none, a made-up one, one off the pattern or too long is not", () => {
  for (const zone of ["Asia/Kolkata", "America/Argentina/Buenos_Aires", "Etc/GMT+5", "UTC"]) {
    assert.equal(timeZoneOf(zone), zone);
  }
  for (const value of [
    undefined,
    "",
    "Mars/Olympus_Mons",
    "Asia/Kolkata; path=/",
    "../../etc/passwd",
    "+05:30",
    `Asia/${"K".repeat(64)}`,
  ]) {
    assert.equal(timeZoneOf(value), undefined, String(value));
  }
});
