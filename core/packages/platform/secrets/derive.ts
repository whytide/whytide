// deriveSecret (architecture §15): a value a flow needs again later but must not store, such as
// email's PKCE verifier, computed from the master key instead of kept in the database. It is an
// HMAC-SHA-256 of the input under a key HKDF-SHA-256 derives from the current master key for the
// purpose, under a label of its own (keys.ts). It opens nothing, no blob and no unwrap, so the api
// may call it; neither key leaves it. A rotation of the master key changes every derived value.
import { AppError } from "../errors/index.ts";
import { errors } from "./errors.ts";
import { masterKeys, type SecretKeys } from "./keys.ts";

/** 32 bytes, the same for one input, purpose and current master key; an empty purpose is `secret_context_invalid`. */
export function deriveSecret(
  input: string | Uint8Array,
  context: { readonly purpose: string },
  keys: SecretKeys = masterKeys(),
): Buffer {
  if (typeof context.purpose !== "string" || context.purpose === "") {
    throw new AppError(errors.secret_context_invalid, { details: { field: "purpose" } });
  }
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return keys.current.derive(bytes, context.purpose);
}
