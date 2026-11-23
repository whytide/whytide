// The google-kg adapter's live suite (../README.md "Tests"): one lookup of the company the owner names
// in GOOGLE_KG_TEST_NAME, with GOOGLE_KG_API_KEY; skipped without them, refused under
// APP_ENV=production. The offline suite runs in mapping.test.ts.
import { liveSuite } from "../../tests/fixtures/live.ts";
import { googleKgAdapter } from "../index.ts";

liveSuite(googleKgAdapter, "GOOGLE_KG");
