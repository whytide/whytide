// The blob of a secret at rest, version 1 (README "Secrets at rest"): a bytea-ready buffer with a
// fixed header, so the parser needs no length fields, then the ciphertext. Two layers: a random data
// key encrypts the value with AES-256-GCM, the master key wraps that data key with AES-256-GCM. Both
// layers authenticate the context. The value layer's associated data is the format version and the
// context, the same under any master key; the wrap layer's is the full header, key version included,
// and the context. So a blob opens only under its own organization and purpose, and a rotation
// re-wraps the data key under the new master key and leaves the value, its nonce and its tag as they
// are.
//
//   offset  bytes  field
//   0       2      "v1"
//   2       8      key_version: which master key wrapped the data key
//   10      60     the wrapped data key: nonce (12), the encrypted key (32), tag (16)
//   70      12     the value's nonce
//   82      16     the value's tag
//   98      n      the value's ciphertext
import { AppError } from "../errors/index.ts";
import { errors } from "./errors.ts";
import { KEY_VERSION_BYTES, NONCE_BYTES, TAG_BYTES, WRAPPED_KEY_BYTES } from "./keys.ts";

/** What a secret is bound to: a blob opens only under the organization and purpose it was sealed with. */
export type SecretContext = { readonly organizationId: string; readonly purpose: string };
export type SecretBlob = {
  readonly version: 1;
  readonly keyVersion: string;
  /** The first ten bytes, "v1" and the key version: what the wrap layer authenticates with the context. */
  readonly header: Buffer;
  readonly wrappedKey: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
};

const MAGIC = Buffer.from("v1", "ascii");
const KEY_VERSION = new RegExp(`^[0-9a-f]{${KEY_VERSION_BYTES * 2}}$`);
const HEADER_BYTES = MAGIC.length + KEY_VERSION_BYTES;
const WRAPPED_KEY_AT = HEADER_BYTES;
const NONCE_AT = WRAPPED_KEY_AT + WRAPPED_KEY_BYTES;
const TAG_AT = NONCE_AT + NONCE_BYTES;
export const CIPHERTEXT_AT = TAG_AT + TAG_BYTES;

/** The header of a new blob: "v1" and the version of the key that wraps its data key, sixteen hex characters. */
export function headerOf(keyVersion: string): Buffer {
  if (!KEY_VERSION.test(keyVersion)) {
    throw new AppError(errors.secret_master_key_invalid, {
      details: { reason: "invalid_key_version" },
    });
  }
  return Buffer.concat([MAGIC, Buffer.from(keyVersion, "hex")]);
}

/** The value layer's associated data: the format version and the context, the same under any master key. */
export function valueAad(context: SecretContext): Buffer {
  return Buffer.concat([MAGIC, contextBytes(context)]);
}

/** The wrap layer's associated data: the full header, key version included, and the context. */
export function wrapAad(header: Buffer, context: SecretContext): Buffer {
  return Buffer.concat([header, contextBytes(context)]);
}

export function formatSecretBlob(parts: Omit<SecretBlob, "version" | "keyVersion">): Buffer {
  return Buffer.concat([parts.header, parts.wrappedKey, parts.nonce, parts.tag, parts.ciphertext]);
}

/** The parts of a v1 blob, or `secret_blob_invalid` for anything shorter or of another shape. */
export function parseSecretBlob(bytes: Uint8Array): SecretBlob {
  const blob = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = (reason: string) =>
    new AppError(errors.secret_blob_invalid, { details: { reason, blob_bytes: blob.length } });
  if (blob.length < CIPHERTEXT_AT) throw invalid("shorter_than_header");
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw invalid("not_v1");
  const header = blob.subarray(0, HEADER_BYTES);
  return {
    version: 1,
    keyVersion: blob.subarray(MAGIC.length, HEADER_BYTES).toString("hex"),
    header,
    wrappedKey: blob.subarray(WRAPPED_KEY_AT, NONCE_AT),
    nonce: blob.subarray(NONCE_AT, TAG_AT),
    tag: blob.subarray(TAG_AT, CIPHERTEXT_AT),
    ciphertext: blob.subarray(CIPHERTEXT_AT),
  };
}

/** The context as both layers authenticate it: one JSON object in fixed order; an empty field is `secret_context_invalid`. */
function contextBytes(context: SecretContext): Buffer {
  for (const field of ["organizationId", "purpose"] as const) {
    if (typeof context[field] !== "string" || context[field] === "") {
      throw new AppError(errors.secret_context_invalid, { details: { field } });
    }
  }
  const encoded = JSON.stringify({
    organizationId: context.organizationId,
    purpose: context.purpose,
  });
  return Buffer.from(encoded, "utf8");
}
