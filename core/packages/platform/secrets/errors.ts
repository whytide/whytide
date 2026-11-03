// The codes of secrets at rest (docs/rules/security.md §4). None is a client's fault: a key the host
// lacks or cannot parse, a blob opened under another organization or purpose, a blob that is not one
// of ours. The status is set so that the `*_invalid` suffix does not turn two of them into a 400.
import { defineErrors } from "../errors/index.ts";

export const errors = defineErrors({
  secret_master_key_invalid: { status: 500 },
  secret_key_unavailable: { status: 500 },
  secret_context_invalid: { status: 500 },
  secret_context_mismatch: { status: 500 },
  secret_blob_invalid: { status: 500 },
});
