// The key guard (../README.md "Keys"), unit-tested: every key an adapter touches goes through
// fileKey() or filePrefix(), so this is the port-level part of the contract, run by test:contract as
// <port>/tests/contract.test.ts; the adapters' suites prove that each one calls the guard.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAppError } from "@whytide/platform";
import { fileKey, filePrefix } from "../port.ts";

const A = "wsp_01JB7M3Q8X";
const a255 = "a".repeat(255);
/** 1 024 characters whole under A's folder, of 17. */
const longest = `imports/${a255}/${a255}/${a255}/${"a".repeat(231)}`;
const refused = (reason: string) => (error: unknown) =>
  isAppError(error) &&
  error.code === "files_key_outside_workspace" &&
  error.details?.reason === reason;

test("a key relative to the workspace's folder, or its whole key, gives the whole key", () => {
  assert.equal(fileKey(A, "imports/job_1.csv"), `w/${A}/imports/job_1.csv`);
  assert.equal(fileKey(A, `w/${A}/imports/job_1.csv`), `w/${A}/imports/job_1.csv`);
  assert.equal(fileKey(A, "raw/signals/run-1/page.2.json"), `w/${A}/raw/signals/run-1/page.2.json`);
  assert.equal(fileKey(A, longest).length, 1024);
});

test("every other key is files_key_outside_workspace, with the reason and never the key", () => {
  const reasons: Record<string, string> = {
    "": "an empty segment",
    "/imports/a.csv": "an empty segment",
    "imports//a.csv": "an empty segment",
    "imports/": "an empty segment",
    ".": "a . or .. segment",
    "imports/./a.csv": "a . or .. segment",
    "../wsp_B/a.csv": "a . or .. segment",
    "imports/../../w/wsp_B/a.csv": "a . or .. segment",
    "imports\\..\\a.csv": "a character other than letters, digits, ., _ and -",
    "%2e%2e/a.csv": "a character other than letters, digits, ., _ and -",
    "imports/a%2Fb.csv": "a character other than letters, digits, ., _ and -",
    "imports/a\nb.csv": "a character other than letters, digits, ., _ and -",
    "imports/a\u0000.csv": "a character other than letters, digits, ., _ and -",
    "imports/a\u007f.csv": "a character other than letters, digits, ., _ and -",
    "imports/café menu.csv": "a character other than letters, digits, ., _ and -",
    "w/wsp_B/imports/a.csv": "not this workspace's folder",
    [`w/${A}`]: "not this workspace's folder",
    w: "not this workspace's folder",
    [`w/${A}/`]: "an empty segment",
    [`imports/${a255}a`]: "a segment longer than 255 characters",
    [`${longest}a`]: "longer than 1024 characters",
  };
  for (const [key, reason] of Object.entries(reasons)) {
    assert.throws(() => fileKey(A, key), refused(reason), JSON.stringify(key));
  }
  for (const id of ["", "wsp_", "wsp_a/../wsp_b", "org_01JB7M3Q8X", "wsp_a b"]) {
    assert.throws(() => fileKey(id, "imports/a.csv"), refused("not a workspace id"), id);
  }
});

test("a listing prefix may be empty or end in /, under the same refusals", () => {
  assert.equal(filePrefix(A, ""), `w/${A}/`);
  assert.equal(filePrefix(A, "imports/"), `w/${A}/imports/`);
  assert.equal(filePrefix(A, "raw/sig"), `w/${A}/raw/sig`);
  assert.equal(filePrefix(A, `w/${A}/`), `w/${A}/`);
  assert.throws(() => filePrefix(A, "/"), refused("an empty segment"));
  assert.throws(() => filePrefix(A, "imports//"), refused("an empty segment"));
  assert.throws(() => filePrefix(A, "../"), refused("a . or .. segment"));
  assert.throws(() => filePrefix(A, "w/wsp_B/"), refused("not this workspace's folder"));
});
