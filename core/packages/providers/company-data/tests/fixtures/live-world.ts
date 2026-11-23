// A live world for ../contract.test.ts, run through `node --test` as an adapter's live suite runs: a
// stand-in adapter counting its lookups, answered by the fake as a vendor would answer the one
// company the owner names. The suite makes exactly one lookup, of that company, and skips every
// other case; under APP_ENV=production, companyDataCases refuses to start. Never a vendor's API.
import assert from "node:assert/strict";
import { after } from "node:test";
import { contractSuite } from "../../../testing/index.ts";
import { companyDataCases, type LiveWorld } from "../../contract.ts";
import { companyDataFake } from "../../fake/index.ts";
import { FACTS, PAGE } from "../../fake/tests/world.ts";
import { companyDataPort } from "../../port.ts";

let lookups = 0;
const world: LiveWorld = {
  live: true,
  company: () => {
    companyDataFake.seedCompany(PAGE, FACTS);
    return { linkedinUrl: PAGE };
  },
};

contractSuite(
  companyDataPort,
  {
    port: companyDataPort,
    name: "live-stand-in",
    requires: [],
    create: () => ({
      lookupCompany: async (lookup) => {
        lookups += 1;
        return companyDataFake.lookupCompany(lookup);
      },
    }),
  },
  companyDataCases(world),
);

after(() => {
  console.log(`live lookups: ${lookups}`);
  assert.equal(lookups, 1, "a live run makes exactly one lookup");
});
