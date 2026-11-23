// The pdl adapter's live suite (../README.md "Tests"): the port's contract on People Data Labs' API
// with the owner's key, one lookup of the company PDL_TEST_LINKEDIN_URL, _DOMAIN or _NAME names.
// Skipped while none is set, and while PDL_API_KEY is empty; refused under APP_ENV=production.
// Every other case runs offline, in mapping.test.ts.
import { liveSuite } from "../../tests/fixtures/live.ts";
import { pdlAdapter } from "../index.ts";

liveSuite(pdlAdapter, "PDL");
