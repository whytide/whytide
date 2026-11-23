// The tomba adapter's live suite (../README.md "Tests"): the port's contract on Tomba's API with the
// owner's key and secret, one lookup of the person TOMBA_TEST_FIRST_NAME, _LAST_NAME and _DOMAIN
// name. Skipped while one is unset, and while TOMBA_KEY or TOMBA_SECRET is empty; refused under
// APP_ENV=production. Every other case runs offline, in mapping.test.ts.
import { liveSuite } from "../../tests/fixtures/live.ts";
import { tombaAdapter } from "../index.ts";

liveSuite(tombaAdapter, "TOMBA");
