// The companies-house adapter's live suite (../README.md "Tests"): one lookup of the company the owner
// names in COMPANIES_HOUSE_TEST_NAME, with the hint GB and COMPANIES_HOUSE_API_KEY; skipped without
// them, refused under APP_ENV=production. The offline suite runs in mapping.test.ts.
import { liveSuite } from "../../tests/fixtures/live.ts";
import { companiesHouseAdapter } from "../index.ts";

liveSuite(companiesHouseAdapter, "COMPANIES_HOUSE", { countryHint: "GB" });
