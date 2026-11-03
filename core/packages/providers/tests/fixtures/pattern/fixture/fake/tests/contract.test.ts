// What a port task writes as <port>/fake/tests/contract.test.ts (README.md "The contract suite"): the
// one contractSuite call of the adapter. tests/pattern.test.ts runs this file through the test runner.
import { contractSuite } from "../../../../../../testing/index.ts";
import { fixtureCases } from "../../contract.ts";
import { fixturePort } from "../../port.ts";
import { fixtureFakeAdapter } from "../index.ts";

contractSuite(fixturePort, fixtureFakeAdapter, fixtureCases);
