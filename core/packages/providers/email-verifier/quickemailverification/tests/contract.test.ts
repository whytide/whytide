// The quickemailverification adapter's live suite (../README.md "Tests"): the port's contract on the
// vendor's API with the owner's key, one check of QUICKEMAILVERIFICATION_TEST_ADDRESS. Skipped while
// it or QUICKEMAILVERIFICATION_API_KEY is empty; refused under APP_ENV=production. Every other case
// runs offline, in mapping.test.ts.
import { liveSuite } from "../../tests/fixtures/live.ts";
import { quickEmailVerificationAdapter } from "../index.ts";

liveSuite(quickEmailVerificationAdapter, "QUICKEMAILVERIFICATION");
