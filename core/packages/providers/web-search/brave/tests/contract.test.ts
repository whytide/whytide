// The Brave adapter's one contractSuite call (../../../README.md "The contract suite"): the port's
// cases against Brave's API, as a live world, one search of the owner's BRAVE_TEST_QUERY and every
// other case skipped. Skipped while BRAVE_TEST_QUERY is unset, so that the key alone never reaches
// the network, and while BRAVE_API_KEY is empty (README.md "The live check"; .env.local is not read);
// refused under APP_ENV=production. The offline cases run in mapping.test.ts, on 127.0.0.1.
import { describe, it } from "node:test";
import { contractSuite } from "../../../testing/index.ts";
import { webSearchCases } from "../../contract.ts";
import { webSearchPort } from "../../port.ts";
import { LIVE_COUNT } from "../constants.ts";
import { braveAdapter } from "../index.ts";

const query = process.env.BRAVE_TEST_QUERY;
if (!query) {
  describe(`${webSearchPort.name} contract: ${braveAdapter.name}`, () => {
    it('skipped: no BRAVE_TEST_QUERY (README.md "The live check")', { skip: true }, () => {});
  });
} else {
  const cases = webSearchCases({ live: true, search: () => ({ query, count: LIVE_COUNT }) });
  contractSuite(webSearchPort, braveAdapter, cases);
}
