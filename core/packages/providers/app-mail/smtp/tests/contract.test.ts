// The smtp adapter's contract suite (README.md "The contract suite"), against the shared stack's
// Mailpit, which is local, so the suite never skips: .env.local (pnpm env:create) gives the slice's
// SMTP_* and MAILPIT_API_URL, loaded before the suite starts the adapter.
import { contractSuite } from "../../../testing/index.ts";
import { appMailCases } from "../../contract.ts";
import { appMailPort } from "../../port.ts";
import { loadEnvLocal, readMailpit } from "../../testing/index.ts";
import { smtpAdapter } from "../index.ts";

loadEnvLocal();
contractSuite(appMailPort, smtpAdapter, appMailCases(readMailpit));
