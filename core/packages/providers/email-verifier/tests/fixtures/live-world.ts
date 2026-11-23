// A live world for ../contract.test.ts, run through `node --test` as an adapter's live suite runs: a
// stand-in adapter counting its checks, answered by the fake as a vendor would answer the one address
// the owner names. The suite makes exactly one check, of that address, and skips every other case;
// under APP_ENV=production, emailVerifierCases refuses to start. Never a vendor's API.
import assert from "node:assert/strict";
import { after } from "node:test";
import { contractSuite } from "../../../testing/index.ts";
import { emailVerifierCases, type LiveWorld } from "../../contract.ts";
import { emailVerifierFake } from "../../fake/index.ts";
import { addressWith } from "../../fake/tests/world.ts";
import { emailVerifierPort } from "../../port.ts";

let checks = 0;
const world: LiveWorld = { live: true, address: () => addressWith("valid") };

contractSuite(
  emailVerifierPort,
  {
    port: emailVerifierPort,
    name: "live-stand-in",
    requires: [],
    create: () => ({
      verifyEmail: async (input) => {
        checks += 1;
        return emailVerifierFake.verifyEmail(input);
      },
    }),
  },
  emailVerifierCases(world),
);

after(() => {
  console.log(`live checks: ${checks}`);
  assert.equal(checks, 1, "a live run makes exactly one check");
});
