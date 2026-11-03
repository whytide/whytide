// The Unipile adapter's one contractSuite call (../../../README.md "The contract suite"): the port's
// cases against Unipile, in the world of live.ts. Skipped while no UNIPILE_TEST_* variable is set,
// so that the adapter's own variables never reach the network alone, and while UNIPILE_BASE_URL,
// UNIPILE_API_KEY, UNIPILE_WEBHOOK_SECRET or UNIPILE_CURSOR_SECRET is empty in the environment
// (README.md "Sandbox"; .env.local is not read). The send cases run only through live.ts's gate
// (README.md "Live sends"). The vendor cannot be made to rate-limit: the 429 is mapping.test.ts's.
// The event cases read nothing: live.ts builds Unipile's events, which mapping.test.ts runs offline.
import { describe, it } from "node:test";
import { contractSuite } from "../../../testing/index.ts";
import { linkedinCases } from "../../contract.ts";
import { linkedinPort } from "../../port.ts";
import { unipileAdapter } from "../index.ts";
import { liveVariables, unipileWorld } from "./live.ts";

if (liveVariables(process.env).length === 0) {
  describe(`${linkedinPort.name} contract: ${unipileAdapter.name}`, () => {
    it('skipped: no UNIPILE_TEST_* variable (README.md "Sandbox")', { skip: true }, () => {});
  });
} else {
  contractSuite(linkedinPort, unipileAdapter, linkedinCases(unipileWorld(process.env)));
}
