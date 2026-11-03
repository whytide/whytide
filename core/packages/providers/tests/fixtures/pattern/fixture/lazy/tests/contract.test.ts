// The lazy adapter's suite, run by tests/pattern.test.ts with the fake's and echo's.
import { contractSuite } from "../../../../../../testing/index.ts";
import { fixtureCases } from "../../contract.ts";
import { fixturePort } from "../../port.ts";
import { lazyAdapter } from "../index.ts";

contractSuite(fixturePort, lazyAdapter, fixtureCases);
