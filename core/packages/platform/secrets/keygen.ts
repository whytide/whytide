// `pnpm secrets:keygen`: prints a new app master key, 32 random bytes in base64, on one line, for
// APP_MASTER_KEY in .env.local and nowhere in the repository. The pre-commit hook rejects a key next
// to its variable name; a bare key it cannot tell from any base64, so never paste one into a doc or
// a test either.
import { newMasterKey } from "./keys.ts";

process.stdout.write(`${newMasterKey()}\n`);
