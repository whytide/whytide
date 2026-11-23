// deploy:check's source names (deploy/scripts/constants.ts, SOURCE_NAMES; README "A name that cannot
// run"): each list may name the sources the module defines of the list's kind, every one of them,
// the company list `company-data` too, and the email list `email-finder` (gamma-en-080). Deploy scripts import no module, so this test keeps the
// table in step: a source added, renamed or removed fails it until the table follows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPANY_DATA } from "../domain/constants.ts";
import { EMAIL_FINDER } from "../domain/lookup/constants.ts";
import { definedNames } from "../domain/sources/define.ts";
// Every source of the module, each defined as its file loads.
import "../domain/sources/index.ts";

type Table = { readonly SOURCE_NAMES: Readonly<Record<string, readonly string[]>> };
/** deploy's constants, a file of the repository outside this module: imported, never built. */
const TABLE = new URL("../../../../deploy/scripts/constants.ts", import.meta.url).href;

test("deploy:check's table names company-data, email-finder and every source the module defines, each in the list of its kind", async () => {
  // A specifier in a variable: TypeScript leaves it to Node, which strips the file's types.
  const { SOURCE_NAMES: table } = (await import(TABLE)) as Table;
  const sorted = (names: readonly string[]) => [...names].sort();
  assert.deepEqual(
    Object.fromEntries(Object.entries(table).map(([list, names]) => [list, sorted(names)])),
    {
      ENRICHMENT_COMPANY_SOURCES: sorted([COMPANY_DATA, ...definedNames("company")]),
      ENRICHMENT_PERSON_SOURCES: definedNames("person"),
      ENRICHMENT_EMAIL_SOURCES: sorted([EMAIL_FINDER, ...definedNames("email")]),
    },
    "deploy/scripts/constants.ts follows the module's sources",
  );
});
