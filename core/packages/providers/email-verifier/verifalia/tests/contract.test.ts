// The verifalia adapter's live suite (../README.md "Tests"): the port's contract on the vendor's API
// with the owner's user, one check of VERIFALIA_TEST_ADDRESS. Skipped while it, VERIFALIA_USERNAME or
// VERIFALIA_PASSWORD is empty; refused under APP_ENV=production. Every other case runs offline, in
// mapping.test.ts.
import { liveSuite } from "../../tests/fixtures/live.ts";
import { verifaliaAdapter } from "../index.ts";

liveSuite(verifaliaAdapter, "VERIFALIA");
