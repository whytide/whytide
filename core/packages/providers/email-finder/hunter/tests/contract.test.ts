// The hunter adapter's live suite (../README.md "Tests"): the port's contract on Hunter's API with
// the owner's key, one lookup of the person HUNTER_TEST_FIRST_NAME, _LAST_NAME and _DOMAIN name.
// Skipped while one is unset, and while HUNTER_API_KEY is empty; refused under APP_ENV=production.
// Every other case runs offline, in mapping.test.ts.
import { liveSuite } from "../../tests/fixtures/live.ts";
import { hunterAdapter } from "../index.ts";

liveSuite(hunterAdapter, "HUNTER");
