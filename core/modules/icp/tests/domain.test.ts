// icp's rules without a database (alpha-p4-040; docs/concepts.md): the closed lists, the version
// decision and the weights; the drafter's gate (icp-draft). Then, on the worktree's database, the
// default audience (gamma-p3-020): two first reads at once, and every command without an id. The
// routes are the api host's test, core/apps/api/tests/icp-api.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, servicePrincipal } from "@whytide/platform";
import {
  createAudience,
  getCriteria,
  getIcp,
  readIcpForScoring,
  saveCriteria,
  saveIcp,
} from "../domain/commands.ts";
import { completeGate, limitsGate } from "../domain/draft-gates.ts";
import { DEFAULT_CRITERIA } from "../domain/lists.ts";
import {
  checkWeights,
  hasTargeting,
  type IcpFields,
  targetingChanged,
  targetingOf,
} from "../domain/rules.ts";
import { together } from "./together.ts";

withTestDb();

const principal = servicePrincipal("icp_test");
const run = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });

const fields: IcpFields = {
  name: "EMEA mid-market",
  titles: [" Head of Sales", "Head of Sales", "CRO"],
  seniorities: ["head", "vp", "head"],
  industries: ["Software "],
  sizeRanges: ["201-500", "51-200"],
  countries: ["fr", "DE"],
  mustHaves: " Sells to finance teams ",
  disqualifiers: "",
};

/** The code and details of the AppError `fn` throws. */
function refusal(fn: () => unknown): [string, unknown] {
  try {
    fn();
  } catch (error) {
    if (isAppError(error)) return [error.code, error.details];
    throw error;
  }
  assert.fail("expected an AppError");
}

test("lists: a value off a closed list is its code, naming each path; the rest is normalized", () => {
  assert.deepEqual(targetingOf(fields), {
    titles: ["Head of Sales", "CRO"],
    seniorities: ["vp", "head"],
    industries: ["Software"],
    sizeRanges: ["51-200", "201-500"],
    countries: ["DE", "FR"],
    mustHaves: "Sells to finance teams",
    disqualifiers: "",
  });
  const seniority = refusal(() => targetingOf({ ...fields, seniorities: ["vp", "chief", "boss"] }));
  const fieldsAt = (...paths: string[]) => ({ fields: paths });
  assert.deepEqual(seniority, [
    "icp_unknown_seniority",
    fieldsAt("seniorities.1", "seniorities.2"),
  ]);
  const size = refusal(() => targetingOf({ ...fields, sizeRanges: ["10001+"] }));
  assert.deepEqual(size, ["icp_unknown_size_range", fieldsAt("sizeRanges.0")]);
  const country = refusal(() => targetingOf({ ...fields, countries: ["FR", "XK", "UK"] }));
  assert.deepEqual(country, ["icp_unknown_country", fieldsAt("countries.1", "countries.2")]);
});

test("version: any targeting field moves it, compared as sets; the name alone does not", () => {
  const stored = targetingOf(fields);
  const same = targetingOf({ ...fields, name: "Renamed", titles: ["CRO", "Head of Sales"] });
  assert.equal(targetingChanged(stored, same), false);
  const changes: Partial<IcpFields>[] = [
    { titles: ["CRO"] },
    { seniorities: ["vp"] },
    { industries: ["Fintech"] },
    { sizeRanges: ["51-200"] },
    { countries: ["FR"] },
    { mustHaves: "Uses a CRM" },
    { disqualifiers: "Agencies" },
  ];
  for (const change of changes) {
    assert.equal(targetingChanged(stored, targetingOf({ ...fields, ...change })), true);
  }
});

test("weights: the defaults sum to 100; any other sum is icp_weights_must_sum_100 with the sum", () => {
  assert.doesNotThrow(() => checkWeights(DEFAULT_CRITERIA));
  const ninety = DEFAULT_CRITERIA.map((row, at) => (at === 0 ? { ...row, weight: 20 } : row));
  assert.deepEqual(
    refusal(() => checkWeights(ninety)),
    ["icp_weights_must_sum_100", { sum: 90 }],
  );
});

test("the drafter's gate: a title given twice, case aside, and a count over its limit fail it, by path; hasTargeting", () => {
  const draft = { ...targetingOf(fields), name: "EMEA mid-market" };
  assert.deepEqual(limitsGate({ ...draft, titles: ["CRO", "Head of Sales"] }).issues, []);
  const industries = Array.from({ length: 31 }, (_, at) => `Industry ${at}`);
  const failed = limitsGate({
    ...draft,
    titles: ["CRO", " cro"],
    industries,
    name: "n".repeat(101),
  });
  assert.deepEqual(
    failed.issues.map((issue) => issue.path),
    ["name", "industries", "titles.1"],
  );
  assert.equal(hasTargeting(targetingOf(fields)), true);
  const none = { ...fields, titles: [], seniorities: [], industries: [], sizeRanges: [] };
  assert.equal(hasTargeting(targetingOf({ ...none, countries: [], mustHaves: " " })), false);
});

test("the drafter's complete gate: an empty list or a blank text fails it, by path; a full draft passes", () => {
  const draft = { ...targetingOf(fields), name: "EMEA mid-market", disqualifiers: "Agencies" };
  assert.deepEqual(completeGate(draft).issues, []);
  const empty = { ...draft, countries: [], sizeRanges: [], disqualifiers: " " };
  assert.deepEqual(
    completeGate(empty).issues.map((issue) => [issue.path, issue.message]),
    [
      ["sizeRanges", "empty"],
      ["countries", "empty"],
      ["disqualifiers", "empty"],
    ],
  );
});

test("the first read: two at once leave one default audience, with its six criteria", async () => {
  const ws = "wsp_first_reads";
  // Both runs open before either reads: both find no default, and both insert one.
  const meet = together(2);
  const read = () =>
    run(ws, async () => {
      await meet();
      return getIcp(ws);
    });
  const [first, second] = await Promise.all([read(), read()]);
  assert.equal(first.id, second.id);
  assert.equal(await run(ws, (tx) => tx.icp.count()), 1);
  assert.equal(await run(ws, (tx) => tx.criterion.count()), DEFAULT_CRITERIA.length);
});

test("without an id, every command acts on the default, whatever other audiences the workspace holds", async () => {
  const ws = "wsp_default_kept";
  const theDefault = await run(ws, () => getIcp(ws));
  // A name that sorts first, made after the default: an unordered read could find it.
  const other = await run(ws, () => createAudience({ name: "A first", createdBy: "usr_a" }));
  const moved = DEFAULT_CRITERIA.map((row, at) =>
    at < 2 ? { ...row, weight: 15 + 15 * at } : row,
  );
  assert.equal((await run(ws, () => saveIcp(fields))).id, theDefault.id);
  assert.deepEqual(await run(ws, () => saveCriteria(moved)), moved);
  assert.equal((await run(ws, () => getIcp(ws))).version, 2);
  assert.deepEqual(await run(ws, () => getCriteria(ws)), moved);
  const scored = await run(ws, () => readIcpForScoring(ws));
  assert.deepEqual(
    [scored.icp.id, scored.icp.titles, scored.criteria],
    [theDefault.id, ["Head of Sales", "CRO"], moved],
  );
  const untouched = await run(ws, () => readIcpForScoring(ws, other.id));
  assert.deepEqual(
    [untouched.icp.version, untouched.icp.titles, untouched.criteria],
    [1, [], DEFAULT_CRITERIA],
  );
});
