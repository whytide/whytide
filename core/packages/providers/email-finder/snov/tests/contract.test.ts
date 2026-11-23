// The snov adapter's live suite (../README.md "Tests"): the port's contract on Snov.io's API with
// the owner's key, one lookup of the person SNOV_TEST_FIRST_NAME, _LAST_NAME and _DOMAIN name.
// Skipped while one is unset, and while SNOV_CLIENT_ID or SNOV_CLIENT_SECRET is empty; refused under APP_ENV=production.
// Every other case runs offline, in mapping.test.ts.
import { liveSuite } from "../../tests/fixtures/live.ts";
import { snovAdapter } from "../index.ts";

liveSuite(snovAdapter, "SNOV");
