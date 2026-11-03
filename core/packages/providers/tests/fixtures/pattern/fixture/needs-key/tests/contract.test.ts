// The suite on the adapter that needs FIXTURE_API_KEY, run by tests/pattern.test.ts without it: it
// must report "skipped: no credentials" and exit 0.
import { contractSuite } from "../../../../../../testing/index.ts";
import { fixtureCases } from "../../contract.ts";
import { fixturePort } from "../../port.ts";
import { needsKeyAdapter } from "../index.ts";

contractSuite(fixturePort, needsKeyAdapter, fixtureCases);
