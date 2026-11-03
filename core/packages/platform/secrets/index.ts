// Secrets at rest (docs/rules/security.md §4; architecture §15): envelope encryption under the app
// master key with the organization and the purpose as the context, the key-management port of
// architecture §9 with its first adapter. This entry encrypts. Decryption is worker.ts, exported as
// @whytide/platform/secrets/worker to the worker host and a module's workflows/ only, which the lint
// rule decrypt-in-worker-only keeps so; never re-export it, nor keys.ts's unwrapperOf, here.
import { createCipheriv, randomBytes } from "node:crypto";
import { formatSecretBlob, headerOf, type SecretContext, valueAad, wrapAad } from "./blob.ts";
import { KEY_BYTES, masterKeys, NONCE_BYTES, type SecretKeys, TAG_BYTES } from "./keys.ts";

/**
 * The value sealed for one organization and purpose, as a Buffer for a bytea column: a fresh data
 * key per value, so two encryptions of one value never match. The keys default to the host's
 * environment, loaded at the first call.
 */
export function encryptSecret(
  plaintext: string | Uint8Array,
  context: SecretContext,
  keys: SecretKeys = masterKeys(),
): Buffer {
  const header = headerOf(keys.current.keyVersion);
  const wrapData = wrapAad(header, context);
  const valueData = valueAad(context);
  const dataKey = randomBytes(KEY_BYTES);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(valueData);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrappedKey = keys.current.wrap(dataKey, wrapData);
    return formatSecretBlob({ header, wrappedKey, nonce, tag: cipher.getAuthTag(), ciphertext });
  } finally {
    dataKey.fill(0);
  }
}

export { parseSecretBlob, type SecretBlob, type SecretContext } from "./blob.ts";
export { type KeyWrapper, loadMasterKeys, newMasterKey, type SecretKeys } from "./keys.ts";
