// The key-management port's first adapter, the app master key (architecture §9, §15): a 32-byte key
// from APP_MASTER_KEY wraps and unwraps the data keys with AES-256-GCM, taking the blob's header and
// context as associated data; APP_MASTER_KEY_PREVIOUS unwraps only, for the rotation zeta brings. A
// blob names its key by a version, eight bytes of an HMAC the key computes over a fixed label: it
// says which key, nothing about it. The key bytes live in the wrapper's closure, so a logged or
// spread key ring shows versions only; the unwrap is not on the wrapper at all but behind
// unwrapperOf, which only secrets/worker.ts calls, so holding the keys gives the api no way to
// decrypt. A cloud key service replaces masterKeyWrapper and registers its unwrap the same way. Its
// derive step (deriveSecret, derive.ts) computes a value from the key without opening anything.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { Env } from "../config/define.ts";
import { AppError } from "../errors/index.ts";
import { secretsConfig } from "./config.ts";
import { errors } from "./errors.ts";

/** One key of the port: wraps a data key under itself. Its unwrap is the worker entry's to reach. */
export type KeyWrapper = {
  /** Sixteen hex characters, the blob's key_version. */
  readonly keyVersion: string;
  wrap(dataKey: Buffer, associatedData: Buffer): Buffer;
  /** 32 bytes: an HMAC-SHA-256 of the input under a key HKDF-SHA-256 derives from this key for the purpose. */
  derive(input: Buffer, purpose: string): Buffer;
};
/** Throws a plain Error when the key or the associated data are not the wrap's. */
export type Unwrap = (wrapped: Buffer, associatedData: Buffer) => Buffer;
export type SecretKeys = { readonly current: KeyWrapper; readonly previous?: KeyWrapper };

export const KEY_BYTES = 32;
export const KEY_VERSION_BYTES = 8;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
/** A wrapped data key: its nonce, the encrypted key, the tag. */
export const WRAPPED_KEY_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES;
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/;
const VERSION_LABEL = "whytide.secrets.key_version.v1";
/** HKDF's salt for derive: a label of its own, so no derived key is ever a wrap key or a version. */
const DERIVE_LABEL = "whytide.secrets.derive.v1";
const unwrappers = new WeakMap<KeyWrapper, Unwrap>();
let loaded: SecretKeys | undefined;

/** A new master key, 32 random bytes in base64: what `pnpm secrets:keygen` prints. */
export function newMasterKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/**
 * The keys of APP_MASTER_KEY and APP_MASTER_KEY_PREVIOUS, validated: `secret_key_unavailable` when
 * the first is unset, `secret_master_key_invalid` naming the variable when one is malformed or both
 * are the same key. A host calls it at start; a test passes its own environment.
 */
export function loadMasterKeys(env?: Env): SecretKeys {
  const current = env ? env.APP_MASTER_KEY : secretsConfig.APP_MASTER_KEY;
  const previous = env ? env.APP_MASTER_KEY_PREVIOUS : secretsConfig.APP_MASTER_KEY_PREVIOUS;
  if (!current?.trim()) {
    throw new AppError(errors.secret_key_unavailable, {
      details: { variable: "APP_MASTER_KEY", reason: "not_set" },
    });
  }
  const keys = { current: masterKeyWrapper(parseMasterKey(current, "APP_MASTER_KEY")) };
  if (!previous?.trim()) return Object.freeze(keys);
  const wrapper = masterKeyWrapper(parseMasterKey(previous, "APP_MASTER_KEY_PREVIOUS"));
  if (wrapper.keyVersion === keys.current.keyVersion) {
    throw new AppError(errors.secret_master_key_invalid, {
      details: { variable: "APP_MASTER_KEY_PREVIOUS", reason: "same_as_current" },
    });
  }
  return Object.freeze({ ...keys, previous: wrapper });
}

/** The host's keys, loaded from the environment once, at the first secret. */
export function masterKeys(): SecretKeys {
  loaded ??= loadMasterKeys();
  return loaded;
}

/** The unwrap behind a wrapper, for secrets/worker.ts; undefined for a wrapper nobody registered. */
export function unwrapperOf(wrapper: KeyWrapper): Unwrap | undefined {
  return unwrappers.get(wrapper);
}

/** An adapter pairs its wrapper with its unwrap here, where only the worker entry reads it. */
export function registerUnwrapper(wrapper: KeyWrapper, unwrap: Unwrap): void {
  unwrappers.set(wrapper, unwrap);
}

function parseMasterKey(value: string, variable: string): Buffer {
  const text = value.trim();
  const key = Buffer.from(text, "base64");
  if (!BASE64_KEY.test(text) || key.length !== KEY_BYTES) {
    throw new AppError(errors.secret_master_key_invalid, {
      details: { variable, reason: "expected_32_bytes_base64" },
    });
  }
  return key;
}

/** The master-key adapter: AES-256-GCM with a fresh random nonce per wrap, the tag in full. */
function masterKeyWrapper(key: Buffer): KeyWrapper {
  const keyVersion = createHmac("sha256", key)
    .update(VERSION_LABEL)
    .digest()
    .subarray(0, KEY_VERSION_BYTES)
    .toString("hex");
  const wrapper: KeyWrapper = Object.freeze({
    keyVersion,
    wrap(dataKey, associatedData) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(associatedData);
      const encrypted = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]);
    },
    derive(input, purpose) {
      const derived = Buffer.from(hkdfSync("sha256", key, DERIVE_LABEL, purpose, KEY_BYTES));
      try {
        return createHmac("sha256", derived).update(input).digest();
      } finally {
        derived.fill(0);
      }
    },
  });
  registerUnwrapper(wrapper, (wrapped, associatedData) => {
    const nonce = wrapped.subarray(0, NONCE_BYTES);
    const encrypted = wrapped.subarray(NONCE_BYTES, NONCE_BYTES + KEY_BYTES);
    const tag = wrapped.subarray(NONCE_BYTES + KEY_BYTES, WRAPPED_KEY_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  });
  return wrapper;
}
