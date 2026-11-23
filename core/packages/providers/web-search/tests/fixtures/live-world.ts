// A live world for ../contract.test.ts, run through `node --test` as an adapter's live suite runs: a
// stand-in adapter counting its searches, answered by the fake as a vendor would answer the one query
// the owner names. The suite makes exactly one search, of that query, and skips every other case;
// under APP_ENV=production, webSearchCases refuses to start. Never a vendor's API.
import assert from "node:assert/strict";
import { after } from "node:test";
import { contractSuite } from "../../../testing/index.ts";
import { type LiveWorld, webSearchCases } from "../../contract.ts";
import { webSearchFake } from "../../fake/index.ts";
import { QUERY, RESULTS } from "../../fake/tests/world.ts";
import { webSearchPort } from "../../port.ts";

let searches = 0;
const world: LiveWorld = {
  live: true,
  search: () => {
    webSearchFake.seedResults(QUERY, RESULTS);
    return { query: QUERY, count: 3 };
  },
};

contractSuite(
  webSearchPort,
  {
    port: webSearchPort,
    name: "live-stand-in",
    requires: [],
    create: () => ({
      searchWeb: async (search) => {
        searches += 1;
        return webSearchFake.searchWeb(search);
      },
    }),
  },
  webSearchCases(world),
);

after(() => {
  console.log(`live searches: ${searches}`);
  assert.equal(searches, 1, "a live run makes exactly one search");
});
