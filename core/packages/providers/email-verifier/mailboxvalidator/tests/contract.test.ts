// The mailboxvalidator adapter's live suite (../README.md "Tests"): the port's contract on the
// vendor's API with the owner's key, one check of MAILBOXVALIDATOR_TEST_ADDRESS. Skipped while it or
// MAILBOXVALIDATOR_API_KEY is empty; refused under APP_ENV=production. Every other case runs
// offline, in mapping.test.ts.
import { liveSuite } from "../../tests/fixtures/live.ts";
import { mailboxValidatorAdapter } from "../index.ts";

liveSuite(mailboxValidatorAdapter, "MAILBOXVALIDATOR");
