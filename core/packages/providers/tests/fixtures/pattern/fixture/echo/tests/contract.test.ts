// What an adapter task writes as <port>/<adapter>/tests/contract.test.ts: the same suite as the fake's,
// one call. tests/pattern.test.ts runs this file through the test runner.
import { contractSuite } from "../../../../../../testing/index.ts";
import { fixtureCases } from "../../contract.ts";
import { fixturePort } from "../../port.ts";
import { echoAdapter } from "../index.ts";

contractSuite(fixturePort, echoAdapter, fixtureCases);
