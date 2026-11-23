// The five verifiers on the list (README.md "Adapters"), as a host starts them, in a child process:
// PROVIDER_EMAIL_VERIFIER as deploy/.env.production.example names them loads each in its order, each
// with its free plan's allowance, once its credentials are set (made up here: nothing is called); a
// verifier whose credentials are missing fails the start with config_invalid.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { promisify } from "node:util";

const LIST = "quickemailverification,mailboxvalidator,verifalia,zerobounce,reoon";
const CREDENTIALS = {
  QUICKEMAILVERIFICATION_API_KEY: "made-up-qev",
  MAILBOXVALIDATOR_API_KEY: "made-up-mbv",
  VERIFALIA_USERNAME: "made-up-user",
  VERIFALIA_PASSWORD: "made-up-password",
  ZEROBOUNCE_API_KEY: "made-up-zerobounce",
  REOON_API_KEY: "made-up-reoon",
};
const ALLOWANCES = [
  "QUICKEMAILVERIFICATION_ALLOWANCE",
  "MAILBOXVALIDATOR_ALLOWANCE",
  "VERIFALIA_ALLOWANCE",
  "ZEROBOUNCE_ALLOWANCE",
  "REOON_ALLOWANCE",
];

async function startWith(env: Record<string, string>): Promise<string> {
  const script = [
    "try {",
    `  const { getAdapters } = await import(${JSON.stringify(import.meta.resolve("../../registry.ts"))});`,
    `  const { emailVerifierConfig, emailVerifierPort } = await import(${JSON.stringify(import.meta.resolve("../port.ts"))});`,
    "  const verifiers = await getAdapters(emailVerifierPort, emailVerifierConfig.PROVIDER_EMAIL_VERIFIER);",
    "  console.log(JSON.stringify(verifiers.map(({ allowance }) => allowance)));",
    "} catch (error) { console.log(error.code); }",
  ].join("\n");
  const unset = Object.fromEntries(ALLOWANCES.map((variable) => [variable, ""]));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    { env: { ...process.env, APP_ENV: "test", ...unset, PROVIDER_EMAIL_VERIFIER: LIST, ...env } },
  );
  return stdout.trim();
}

test("the production example's five load in the owner's order, each with its free plan's allowance; one without its credentials fails the start", async () => {
  const example = readFileSync(
    new URL("../../../../../deploy/.env.production.example", import.meta.url),
    "utf8",
  );
  assert.match(example, new RegExp(`^PROVIDER_EMAIL_VERIFIER=${LIST}$`, "m"));
  const loaded = JSON.parse(await startWith(CREDENTIALS));
  assert.deepEqual(loaded, [
    { calls: 100, per: "day" },
    { calls: 300, per: "month" },
    { calls: 25, per: "day" },
    { calls: 100, per: "month" },
    { calls: 20, per: "day" },
  ]);
  assert.equal(await startWith({ ...CREDENTIALS, VERIFALIA_PASSWORD: "" }), "config_invalid");
});
