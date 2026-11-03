// A fixture of tests/secrets.test.ts: a host imports the package, which must not throw whatever
// APP_MASTER_KEY holds, then loads the master keys at start, as a host does, and reports the outcome
// as one JSON line: the key versions, or the error's code and details. Never a key.
import { isAppError, loadMasterKeys } from "../../../index.ts";

try {
  const keys = loadMasterKeys();
  console.log(
    JSON.stringify({
      ok: true,
      current: keys.current.keyVersion,
      previous: keys.previous?.keyVersion ?? null,
    }),
  );
} catch (error) {
  if (!isAppError(error)) throw error;
  console.log(JSON.stringify({ ok: false, code: error.code, details: error.details }));
}
