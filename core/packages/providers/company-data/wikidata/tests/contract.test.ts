// The wikidata adapter's live suite (../README.md "Tests"): one lookup of the company the owner names
// in WIKIDATA_TEST_NAME, _TEST_DOMAIN or _TEST_LINKEDIN_URL, with WIKIDATA_CONTACT; skipped without
// them, refused under APP_ENV=production. The offline suite runs in mapping.test.ts.
import { liveSuite } from "../../tests/fixtures/live.ts";
import { wikidataAdapter } from "../index.ts";

liveSuite(wikidataAdapter, "WIKIDATA");
