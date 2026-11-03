// The end-to-end test of alpha-p1-070: secrets at rest used the way the api and the worker use
// them. The api encrypts with the package root; the worker decrypts with the worker entry; a value
// comes back only under its own organization and purpose; a rotation keeps the previous key for
// decryption until it is dropped, and re-wraps the data key without touching the value; a host whose
// APP_MASTER_KEY is malformed imports the package, fails at start with the variable's name, and never
// logs the key. The lint allow-list on the worker entry is proven by the rule's own fixtures,
// tools/lint/fixtures/decrypt-in-worker-only, which `pnpm -F lint test` runs; a platform test cannot
// plant a file under core/apps/api/.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as platform from "../index.ts";
import { formatSecretBlob, headerOf, wrapAad } from "../secrets/blob.ts";
import { unwrapperOf } from "../secrets/keys.ts";
import { decryptSecret } from "../secrets/worker.ts";
import { collectLogs, throwsCode } from "../testing/index.ts";

const { createLogger, encryptSecret, isAppError, loadMasterKeys, newMasterKey, parseSecretBlob } =
  platform;
const context = { organizationId: "org_01JAB3K5ZQ7W9R2M4T6V8X0Y1C", purpose: "linkedin_account" };
/** The fixed part of a blob, before the ciphertext; the value's nonce starts at VALUE_AT. */
const HEADER_BYTES = 98;
const VALUE_AT = 70;
const keyring = (current: string, previous?: string) =>
  loadMasterKeys({ APP_MASTER_KEY: current, APP_MASTER_KEY_PREVIOUS: previous });

/** The AppError a call throws, for assertions on its code and details. */
function caught(fn: () => unknown): platform.AppError {
  try {
    fn();
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error("expected an AppError");
}

test("the api encrypts through the package root; decryption exists only in the worker entry", () => {
  assert.equal(typeof encryptSecret, "function");
  assert.equal("decryptSecret" in platform, false);
  assert.equal("unwrapperOf" in platform, false);
  assert.equal("registerUnwrapper" in platform, false);
  assert.equal(typeof decryptSecret, "function");
  const keys = keyring(newMasterKey());
  assert.deepEqual(Object.keys(keys.current), ["keyVersion", "wrap"]);
  assert.equal("unwrap" in keys.current, false);
  assert.equal(typeof unwrapperOf(keys.current), "function");
});

test("a value encrypts to a v1 blob and decrypts under its context; two encryptions differ", () => {
  const keys = keyring(newMasterKey());
  const first = encryptSecret("unipile:acc_7f3e", context, keys);
  const second = encryptSecret("unipile:acc_7f3e", context, keys);
  assert.ok(Buffer.isBuffer(first));
  assert.equal(first.subarray(0, 2).toString("ascii"), "v1");
  assert.equal(parseSecretBlob(first).keyVersion, keys.current.keyVersion);
  assert.notDeepEqual(first, second);
  assert.equal(decryptSecret(first, context, keys).toString("utf8"), "unipile:acc_7f3e");
  assert.equal(decryptSecret(second, context, keys).toString("utf8"), "unipile:acc_7f3e");
  const bytes = encryptSecret(new Uint8Array([0, 1, 2, 255]), context, keys);
  assert.deepEqual([...decryptSecret(bytes, context, keys)], [0, 1, 2, 255]);
  const unicode = encryptSecret("clé — 鍵 🔑", context, keys);
  assert.equal(decryptSecret(unicode, context, keys).toString("utf8"), "clé — 鍵 🔑");
  assert.equal(decryptSecret(encryptSecret("", context, keys), context, keys).length, 0);
});

test("a blob fails under another organization or purpose with secret_context_mismatch", () => {
  const keys = keyring(newMasterKey());
  const blob = encryptSecret("unipile:acc_7f3e", context, keys);
  const other = { ...context, organizationId: "org_01JAB3K5ZQ7W9R2M4T6V8X0Y1D" };
  const error = caught(() => decryptSecret(blob, other, keys));
  assert.equal(error.code, "secret_context_mismatch");
  assert.deepEqual(error.details, {
    organization_id: other.organizationId,
    purpose: context.purpose,
  });
  throwsCode(
    () => decryptSecret(blob, { ...context, purpose: "mailbox_token" }, keys),
    "secret_context_mismatch",
  );
  assert.deepEqual(
    caught(() => encryptSecret("x", { ...context, organizationId: "" }, keys)).details,
    { field: "organizationId" },
  );
  throwsCode(
    () => decryptSecret(blob, { ...context, purpose: "" }, keys),
    "secret_context_invalid",
  );
  assert.equal(decryptSecret(blob, context, keys).toString("utf8"), "unipile:acc_7f3e");
});

test("a rotation: the previous key decrypts while APP_MASTER_KEY_PREVIOUS is set, secret_key_unavailable once unset", () => {
  const [oldKey, newKey] = [newMasterKey(), newMasterKey()];
  const before = keyring(oldKey);
  const blob = encryptSecret("unipile:acc_7f3e", context, before);
  const during = keyring(newKey, oldKey);
  assert.equal(during.previous?.keyVersion, before.current.keyVersion);
  assert.equal(decryptSecret(blob, context, during).toString("utf8"), "unipile:acc_7f3e");
  const fresh = encryptSecret("unipile:acc_7f3e", context, during);
  assert.equal(parseSecretBlob(fresh).keyVersion, during.current.keyVersion);
  assert.notEqual(parseSecretBlob(fresh).keyVersion, parseSecretBlob(blob).keyVersion);
  const after = keyring(newKey);
  assert.equal(after.previous, undefined);
  assert.equal(decryptSecret(fresh, context, after).toString("utf8"), "unipile:acc_7f3e");
  const error = caught(() => decryptSecret(blob, context, after));
  assert.equal(error.code, "secret_key_unavailable");
  assert.deepEqual(error.details, { key_version: before.current.keyVersion });
});

test("a rotation re-wraps the data key under the new master key and leaves the value untouched", () => {
  const before = keyring(newMasterKey());
  const after = keyring(newMasterKey());
  const blob = encryptSecret("unipile:acc_7f3e", context, before);
  // What zeta's rotation tooling will do per row, with the internals: unwrap under the old key,
  // wrap under the new one, keep the value's nonce, tag and ciphertext as they are.
  const parsed = parseSecretBlob(blob);
  const unwrap = unwrapperOf(before.current);
  assert.ok(unwrap);
  const dataKey = unwrap(parsed.wrappedKey, wrapAad(parsed.header, context));
  const header = headerOf(after.current.keyVersion);
  const rewrapped = formatSecretBlob({
    header,
    wrappedKey: after.current.wrap(dataKey, wrapAad(header, context)),
    nonce: parsed.nonce,
    tag: parsed.tag,
    ciphertext: parsed.ciphertext,
  });
  assert.deepEqual(rewrapped.subarray(VALUE_AT), blob.subarray(VALUE_AT));
  assert.equal(parseSecretBlob(rewrapped).keyVersion, after.current.keyVersion);
  assert.equal(decryptSecret(rewrapped, context, after).toString("utf8"), "unipile:acc_7f3e");
  throwsCode(() => decryptSecret(rewrapped, context, before), "secret_key_unavailable");
  throwsCode(
    () => decryptSecret(rewrapped, { ...context, purpose: "mailbox_token" }, after),
    "secret_context_mismatch",
  );
});

test("a malformed key fails at load with the variable's name, and the key never reaches a log line", () => {
  const malformed = `not-a-key-${newMasterKey().slice(0, 8)}`;
  const valid = newMasterKey();
  const error = caught(() => loadMasterKeys({ APP_MASTER_KEY: malformed }));
  assert.equal(error.code, "secret_master_key_invalid");
  assert.deepEqual(error.details, {
    variable: "APP_MASTER_KEY",
    reason: "expected_32_bytes_base64",
  });
  assert.equal(
    caught(() => loadMasterKeys({ APP_MASTER_KEY: valid, APP_MASTER_KEY_PREVIOUS: malformed }))
      .details?.variable,
    "APP_MASTER_KEY_PREVIOUS",
  );
  assert.deepEqual(
    caught(() => loadMasterKeys({ APP_MASTER_KEY: valid, APP_MASTER_KEY_PREVIOUS: valid })).details,
    { variable: "APP_MASTER_KEY_PREVIOUS", reason: "same_as_current" },
  );
  assert.deepEqual(caught(() => loadMasterKeys({})).details, {
    variable: "APP_MASTER_KEY",
    reason: "not_set",
  });
  assert.equal(caught(() => loadMasterKeys({ APP_MASTER_KEY: "" })).code, "secret_key_unavailable");
  assert.doesNotThrow(() => loadMasterKeys({ APP_MASTER_KEY: `${valid} ` }));
});

test("the keys, a blob and a decrypted value never appear in a log line", () => {
  const logs = collectLogs();
  const log = createLogger({ destination: logs.destination, level: "debug" });
  const key = newMasterKey();
  const keys = keyring(key);
  const blob = encryptSecret("unipile:acc_7f3e", context, keys);
  const value = decryptSecret(blob, context, keys);
  const error = caught(() => loadMasterKeys({ APP_MASTER_KEY: `bad-${key}` }));
  log.error({ err: error }, "start failed");
  log.info({ keys, blob, value, nested: { account_ref: value, list: [blob] } }, "stored");
  log.info(blob, "raw");
  const text = logs.raw.join("\n");
  assert.ok(!text.includes(key), "the master key reached a log line");
  assert.ok(!text.includes("unipile:acc_7f3e"), "the plaintext reached a log line");
  assert.ok(!text.includes(blob.toString("base64")) && !text.includes('"data":['), "the blob did");
  const [failed, stored, raw] = logs.lines();
  assert.equal((failed?.err as { code?: string })?.code, "secret_master_key_invalid");
  assert.deepEqual(stored?.keys, { current: { keyVersion: keys.current.keyVersion } });
  assert.deepEqual(
    { blob: stored?.blob, value: stored?.value, nested: stored?.nested },
    {
      blob: "[redacted]",
      value: "[redacted]",
      nested: { account_ref: "[redacted]", list: ["[redacted]"] },
    },
  );
  assert.equal(raw?.binary, "[redacted]");
  assert.equal(JSON.stringify(raw).includes('"0"'), false);
  assert.deepEqual(platform.checkLogLines([logs.raw[0] ?? ""]), []);
});

test("a host imports the package whatever APP_MASTER_KEY holds and fails at start with the variable's name", () => {
  const host = fileURLToPath(new URL("./fixtures/secrets/host.ts", import.meta.url));
  const run = (env: Record<string, string>) => {
    const childEnv = { ...process.env, ...env };
    for (const name of ["APP_MASTER_KEY", "APP_MASTER_KEY_PREVIOUS"]) {
      if (!(name in env)) delete childEnv[name];
    }
    const out = execFileSync(process.execPath, [host], {
      env: childEnv,
      encoding: "utf8",
      timeout: 20_000,
    });
    const last = out.trim().split("\n").at(-1) ?? "{}";
    return { out, report: JSON.parse(last) as Record<string, unknown> };
  };
  const malformed = `not-a-key-${newMasterKey().slice(0, 8)}`;
  const bad = run({ APP_MASTER_KEY: malformed });
  assert.deepEqual(bad.report, {
    ok: false,
    code: "secret_master_key_invalid",
    details: { variable: "APP_MASTER_KEY", reason: "expected_32_bytes_base64" },
  });
  assert.ok(!bad.out.includes(malformed), "the malformed key reached the host's output");
  assert.equal(run({}).report.code, "secret_key_unavailable");
  const key = newMasterKey();
  const good = run({ APP_MASTER_KEY: key });
  assert.equal(good.report.ok, true);
  assert.equal(good.report.current, loadMasterKeys({ APP_MASTER_KEY: key }).current.keyVersion);
  assert.ok(!good.out.includes(key), "the key reached the host's output");
});

test("pnpm secrets:keygen prints a key that loads", () => {
  const keygen = fileURLToPath(new URL("../secrets/keygen.ts", import.meta.url));
  const run = () => execFileSync(process.execPath, [keygen], { encoding: "utf8", timeout: 20_000 });
  const out = run();
  assert.match(out, /^[A-Za-z0-9+/]{43}=\n$/);
  assert.match(loadMasterKeys({ APP_MASTER_KEY: out.trim() }).current.keyVersion, /^[0-9a-f]{16}$/);
  assert.notEqual(run(), out);
});

// Unit: the blob header parser.
test("the blob header parser reads a v1 blob and refuses what is not one", () => {
  const keys = keyring(newMasterKey());
  const blob = encryptSecret("unipile:acc_7f3e", context, keys);
  const parsed = parseSecretBlob(blob);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.keyVersion, keys.current.keyVersion);
  assert.deepEqual(
    [parsed.header.length, parsed.wrappedKey.length, parsed.nonce.length, parsed.tag.length],
    [10, 60, 12, 16],
  );
  assert.equal(parsed.ciphertext.length, blob.length - HEADER_BYTES);
  assert.equal(parsed.ciphertext.length, Buffer.byteLength("unipile:acc_7f3e"));
  assert.equal(parseSecretBlob(new Uint8Array(blob)).keyVersion, parsed.keyVersion);
  const invalid = (bytes: Uint8Array) => caught(() => parseSecretBlob(bytes));
  assert.deepEqual(invalid(blob.subarray(0, HEADER_BYTES - 1)).details, {
    reason: "shorter_than_header",
    blob_bytes: HEADER_BYTES - 1,
  });
  assert.equal(invalid(new Uint8Array(0)).code, "secret_blob_invalid");
  const v2 = Buffer.from(blob);
  v2[1] = "2".charCodeAt(0);
  assert.deepEqual(invalid(v2).details, { reason: "not_v1", blob_bytes: blob.length });
  const other = Buffer.from(blob);
  other[0] = "x".charCodeAt(0);
  assert.equal(invalid(other).code, "secret_blob_invalid");
  assert.equal(invalid(Buffer.from("v1 is just text, not a blob")).code, "secret_blob_invalid");
});

// Unit: the header takes a key version of sixteen hex characters and nothing else.
test("headerOf refuses a key version that is not sixteen hex characters", () => {
  assert.equal(headerOf("00ff00ff00ff00ff").length, 10);
  for (const version of ["v3", "00ff00ff00ff00ff0", "00FF00FF00FF00FF", "", "zz".repeat(8)]) {
    const error = caught(() => headerOf(version));
    assert.equal(error.code, "secret_master_key_invalid");
    assert.deepEqual(error.details, { reason: "invalid_key_version" });
  }
});

test("a tampered blob fails: the key version, the wrapped key, then the value", () => {
  const keys = keyring(newMasterKey());
  const blob = encryptSecret("unipile:acc_7f3e", context, keys);
  const flipped = (offset: number) => {
    const copy = Buffer.from(blob);
    copy[offset] = (copy[offset] ?? 0) ^ 0x01;
    return copy;
  };
  throwsCode(() => decryptSecret(flipped(2), context, keys), "secret_key_unavailable");
  throwsCode(() => decryptSecret(flipped(10), context, keys), "secret_context_mismatch");
  throwsCode(() => decryptSecret(flipped(22), context, keys), "secret_context_mismatch");
  throwsCode(() => decryptSecret(flipped(54), context, keys), "secret_context_mismatch");
  throwsCode(() => decryptSecret(flipped(VALUE_AT), context, keys), "secret_blob_invalid");
  throwsCode(() => decryptSecret(flipped(82), context, keys), "secret_blob_invalid");
  throwsCode(() => decryptSecret(flipped(HEADER_BYTES), context, keys), "secret_blob_invalid");
  assert.deepEqual(caught(() => decryptSecret(flipped(HEADER_BYTES), context, keys)).details, {
    reason: "value_not_authenticated",
    blob_bytes: blob.length,
  });
  throwsCode(
    () => decryptSecret(blob.subarray(0, blob.length - 1), context, keys),
    "secret_blob_invalid",
  );
});
