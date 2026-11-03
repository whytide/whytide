// The unit tests of deploy:check's rules (scripts/deploy-check.ts), on the production example filled
// as an operator fills it, and the example's coverage of deploy/.env.example.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDeploy, parseEnv } from "../scripts/deploy-check.ts";
import { filledProductionEnv, readDeployFile } from "./env-fixture.ts";

const example = readDeployFile(".env.example");
const development = parseEnv(example);
const check = (overrides: Record<string, string> = {}, without: string[] = []) => {
  const env = parseEnv(filledProductionEnv(overrides));
  for (const key of without) env.delete(key);
  return checkDeploy(env, example);
};
const refuses = (findings: string[], key: string) =>
  assert.ok(
    findings.some((finding) => finding.startsWith(`${key} `)),
    `${key}: ${findings.join("; ")}`,
  );

test("deploy:check passes the production example with its secrets filled, not without them", () => {
  assert.deepEqual(check(), []);
  const unfilled = checkDeploy(parseEnv(readDeployFile(".env.production.example")), example);
  for (const key of ["APP_MASTER_KEY", "AUTH_SECRET", "HASH_SALT", "DEV_POSTGRES_PASSWORD"]) {
    refuses(unfilled, key);
  }
});

test("deploy:check refuses a fake adapter, a missing key or secret, and APP_ENV but production", () => {
  refuses(check({ PROVIDER_LLM: "fake" }), "PROVIDER_LLM");
  refuses(check({ PROVIDER_AUTH: "fake" }), "PROVIDER_AUTH");
  refuses(check({}, ["APP_MASTER_KEY"]), "APP_MASTER_KEY");
  refuses(check({ APP_MASTER_KEY: "c2hvcnQ=" }), "APP_MASTER_KEY");
  const key = `${"A".repeat(43)}=`;
  refuses(check({ APP_MASTER_KEY: key, APP_MASTER_KEY_PREVIOUS: key }), "APP_MASTER_KEY_PREVIOUS");
  refuses(check({}, ["AUTH_SECRET"]), "AUTH_SECRET");
  refuses(check({ HASH_SALT: "short" }), "HASH_SALT");
  for (const appEnv of ["development", "test", "staging", ""]) {
    refuses(check({ APP_ENV: appEnv }), "APP_ENV");
  }
  refuses(check({ AUTH_BASE_URL: "http://whytide.example.com" }), "AUTH_BASE_URL");
  refuses(check({ CADDY_INTERNAL_TLS: "1" }), "CADDY_INTERNAL_TLS");
  refuses(check({ APP_DOMAIN: "" }), "APP_DOMAIN");
  refuses(check({ EGRESS_ALLOW_HOSTS: "127.0.0.1:8080" }), "EGRESS_ALLOW_HOSTS");
});

test("deploy:check reads the file as Compose does: a comment after a bare = is the value", () => {
  const lines = ["A= # x", 'B="" # x', "C=abc # x", "D=abc#x", "E='a b' # x", "F=  "];
  const read = { A: "# x", B: "", C: "abc", D: "abc#x", E: "a b", F: "" };
  assert.deepEqual(Object.fromEntries(parseEnv(lines.join("\n"))), read);
  refuses(check({ APP_MASTER_KEY_PREVIOUS: " # secret" }), "APP_MASTER_KEY_PREVIOUS");
  assert.doesNotMatch(readDeployFile(".env.production.example"), /^\w+=[ \t]+#/m);
});

test("deploy:check refuses a development default left in place", () => {
  for (const key of [
    "DEV_POSTGRES_PASSWORD",
    "DEV_MINIO_ROOT_PASSWORD",
    "DATABASE_URL",
    "S3_SECRET_KEY",
  ]) {
    refuses(check({ [key]: development.get(key) ?? "" }), key);
  }
  // The stack's password in a connection string of the server's own.
  const url = new URL("postgresql://postgres:5432/app");
  url.username = "whytide_owner";
  url.password = development.get("DEV_POSTGRES_PASSWORD") ?? "";
  refuses(check({ DATABASE_URL_OWNER: url.href }), "DATABASE_URL_OWNER");
});

test("the production example has every variable of .env.example in its block, but development's own", () => {
  const blocks = (text: string) => {
    const found = new Map<string, string>();
    let block = "";
    for (const line of text.split("\n")) {
      block = /^# ---- (.+) ----$/.exec(line)?.[1] ?? block;
      const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
      if (key) found.set(key, block);
    }
    return found;
  };
  const developmentOnly = new Set([
    ...["DEV_TEMPORAL_UI_PORT", "DEV_MAILPIT_PORT", "DEV_MAILPIT_UI_PORT", "DEV_OTEL_PORT"],
    ...["DEV_OTEL_GRPC_PORT", "DEV_GRAFANA_PORT", "SLICE_NAME", "MAILPIT_API_URL"],
    // identity's smoke test signs it in with a link it reads from Mailpit, which no server runs.
    "SMOKE_EMAIL",
  ]);
  const production = blocks(readDeployFile(".env.production.example"));
  for (const [key, block] of blocks(example)) {
    if (developmentOnly.has(key)) assert.equal(production.get(key), undefined, key);
    else assert.equal(production.get(key), block, `${key} belongs in the ${block} block`);
  }
  const listed = blocks(example);
  for (const [key, block] of production) {
    if (!listed.has(key))
      assert.equal(block, "deploy", `${key}, production's own, belongs in deploy`);
  }
});
