// A live world for ../contract.test.ts, run through `node --test` as an adapter's live suite runs: a
// stand-in adapter counting its lookups, answered by the fake as a vendor would answer the one person
// the owner names. The suite makes exactly one lookup, of that person, and skips every other case;
// under APP_ENV=production, emailFinderCases refuses to start. Never a vendor's API.
import assert from "node:assert/strict";
import { after } from "node:test";
import { contractSuite } from "../../../testing/index.ts";
import { emailFinderCases, type LiveWorld } from "../../contract.ts";
import { emailFinderFake } from "../../fake/index.ts";
import { ADA } from "../../fake/tests/world.ts";
import { emailFinderPort } from "../../port.ts";

let lookups = 0;
const world: LiveWorld = { live: true, person: () => ADA };

contractSuite(
  emailFinderPort,
  {
    port: emailFinderPort,
    name: "live-stand-in",
    requires: [],
    create: () => ({
      findEmail: async (input) => {
        lookups += 1;
        return emailFinderFake.findEmail(input);
      },
    }),
  },
  emailFinderCases(world),
);

after(() => {
  console.log(`live lookups: ${lookups}`);
  assert.equal(lookups, 1, "a live run makes exactly one lookup");
});
