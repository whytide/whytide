// The diffbot adapter's live suite (../README.md "Tests"): the port's contract on Diffbot's API with
// the owner's token, one lookup of the company DIFFBOT_TEST_LINKEDIN_URL, _DOMAIN or _NAME names.
// Skipped while none is set, and while DIFFBOT_TOKEN is empty; refused under APP_ENV=production.
// Every other case runs offline, in mapping.test.ts.
import { liveSuite } from "../../tests/fixtures/live.ts";
import { diffbotAdapter } from "../index.ts";

liveSuite(diffbotAdapter, "DIFFBOT");
