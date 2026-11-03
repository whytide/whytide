// The worker's decrypt entry, @whytide/platform/secrets/worker (architecture §15: a provider token
// is decrypted by the worker only). Never re-exported from the package root; the lint rule
// decrypt-in-worker-only allows the import under core/apps/worker/ and a module's workflows/ only.
import { createDecipheriv } from "node:crypto";
import { AppError } from "../errors/index.ts";
import { parseSecretBlob, type SecretContext, valueAad, wrapAad } from "./blob.ts";
import { errors } from "./errors.ts";
import { masterKeys, type SecretKeys, TAG_BYTES, unwrapperOf } from "./keys.ts";

export type { SecretContext, SecretKeys };

/**
 * The value a blob holds, as bytes (`.toString("utf8")` for a string; `.fill(0)` once used), under
 * the organization and purpose it was sealed with. `secret_key_unavailable` when no loaded key has
 * the blob's key version, `secret_context_mismatch` when the context is not the one it was sealed
 * with (the wrap authenticates it, so a tampered wrapped key reads the same way), `secret_blob_invalid`
 * when the blob is not one of ours or its value no longer authenticates.
 */
export function decryptSecret(
  blob: Uint8Array,
  context: SecretContext,
  keys: SecretKeys = masterKeys(),
): Buffer {
  const parsed = parseSecretBlob(blob);
  const wrapper = [keys.current, keys.previous].find((k) => k?.keyVersion === parsed.keyVersion);
  const unwrap = wrapper && unwrapperOf(wrapper);
  if (!unwrap) {
    throw new AppError(errors.secret_key_unavailable, {
      details: { key_version: parsed.keyVersion },
    });
  }
  const wrapData = wrapAad(parsed.header, context);
  const valueData = valueAad(context);
  let dataKey: Buffer;
  try {
    dataKey = unwrap(parsed.wrappedKey, wrapData);
  } catch (cause) {
    throw new AppError(errors.secret_context_mismatch, {
      details: { organization_id: context.organizationId, purpose: context.purpose },
      cause,
    });
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey, parsed.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(valueData);
    decipher.setAuthTag(parsed.tag);
    return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
  } catch (cause) {
    throw new AppError(errors.secret_blob_invalid, {
      details: { reason: "value_not_authenticated", blob_bytes: blob.length },
      cause,
    });
  } finally {
    dataKey.fill(0);
  }
}
