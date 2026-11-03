// The suite on the broken adapter, run by tests/pattern.test.ts: it must fail, naming greet.
import { contractSuite } from "../../../../../../testing/index.ts";
import { fixtureCases } from "../../contract.ts";
import { fixturePort } from "../../port.ts";
import { brokenAdapter } from "../index.ts";

contractSuite(fixturePort, brokenAdapter, fixtureCases);
