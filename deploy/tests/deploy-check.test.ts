// The unit tests of deploy:check's rules (scripts/deploy-check.ts), on the production example filled
// as an operator fills it, and the example's coverage of deploy/.env.example. The lists' tables
// (scripts/constants.ts) are kept in step by providers' and enrichment's tests/deploy-table.test.ts;
// the adapters' table holds every PROVIDER_ selector (gamma-en-100).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ADAPTER_VARIABLES, OPTIONAL_SELECTORS, SOURCE_NAMES } from "../scripts/constants.ts";
import { checkDeploy, parseEnv } from "../scripts/deploy-check.ts";
import { filledProductionEnv, readDeployFile } from "./env-fixture.ts";

const example = readDeployFile(".env.example");
const development = parseEnv(example);
const production = parseEnv(readDeployFile(".env.production.example"));
/**
 * Each variable an adapter of the table cannot run without, made up at random where the production
 * example leaves it empty: the operator's keys and contacts for the adapters the example lists, and
 * AUTH_SECRET, long enough for its own rule.
 */
const adapterKeys = () =>
  Object.fromEntries(
    Object.values(ADAPTER_VARIABLES)
      .flatMap((adapters) => Object.values(adapters).flat())
      .filter((variable) => (production.get(variable) ?? "") === "")
      .map((variable) => [variable, randomBytes(32).toString("hex")]),
  );
const check = (overrides: Record<string, string> = {}, without: string[] = []) => {
  const env = parseEnv(filledProductionEnv({ ...adapterKeys(), ...overrides }));
  for (const key of without) env.delete(key);
  return checkDeploy(env, example);
};
const refuses = (findings: string[], key: string) =>
  assert.ok(
    findings.some((finding) => finding.startsWith(`${key} `)),
    `${key}: ${findings.join("; ")}`,
  );

test("deploy:check passes the production example with its secrets and its adapters' keys filled, not without them", () => {
  assert.deepEqual(check(), []);
  const unfilled = checkDeploy(production, example);
  for (const key of ["APP_MASTER_KEY", "AUTH_SECRET", "HASH_SALT", "DEV_POSTGRES_PASSWORD"]) {
    refuses(unfilled, key);
  }
  // The example's selectors and lists name adapters whose keys and contacts the operator fills, or
  // drops them from a list (README.md "Install").
  for (const key of [
    "PROVIDER_COMPANY_DATA",
    "PROVIDER_EMAIL_FINDER",
    "PROVIDER_EMAIL_VERIFIER",
    "PROVIDER_LINKEDIN",
    "PROVIDER_LLM",
    "PROVIDER_WEB_SEARCH",
  ]) {
    refuses(unfilled, key);
  }
  for (const finding of [
    "PROVIDER_AUTH lists better-auth, but AUTH_SECRET is not set",
    "PROVIDER_COMPANY_DATA lists companies-house, but COMPANIES_HOUSE_API_KEY is not set",
    "PROVIDER_LINKEDIN lists unipile, but UNIPILE_BASE_URL is not set",
    "PROVIDER_LLM lists anthropic, but LLM_ANTHROPIC_API_KEY is not set",
  ]) {
    assert.ok(unfilled.includes(finding), finding);
  }
});

test("deploy:check's table holds every PROVIDER_ selector of the production example", () => {
  const selectors = [...production.keys()].filter((key) => key.startsWith("PROVIDER_"));
  assert.ok(selectors.length > 0);
  assert.deepEqual(selectors.sort(), Object.keys(ADAPTER_VARIABLES).sort());
});

test("deploy:check refuses a listed adapter without a variable it cannot run without, naming the list, the adapter and the variable, never a value", () => {
  // Sign-in's two variables have rules of their own, which refuse them empty too.
  const own: Record<string, string> = {
    AUTH_SECRET: "AUTH_SECRET is missing or shorter than 32 characters",
    AUTH_BASE_URL: "AUTH_BASE_URL is '': sign-in links open on https: only",
  };
  for (const [list, adapters] of Object.entries(ADAPTER_VARIABLES)) {
    for (const [adapter, variables] of Object.entries(adapters)) {
      for (const variable of variables) {
        const findings = [`${list} lists ${adapter}, but ${variable} is not set`];
        if (Object.hasOwn(own, variable)) findings.push(own[variable] ?? "");
        assert.deepEqual(check({ [list]: adapter, [variable]: "" }), findings);
        assert.deepEqual(check({ [list]: adapter }, [variable]), findings);
      }
    }
  }
  // Dropped from its list, an adapter needs no key.
  assert.deepEqual(check({ PROVIDER_COMPANY_DATA: "wikidata", COMPANIES_HOUSE_API_KEY: "" }), []);
});

test("deploy:check refuses the mail, sign-in and files adapters without a variable they declare, naming the selector, the adapter and the variable, and takes their optional ones empty (gamma-en-105)", () => {
  assert.deepEqual(check({ PROVIDER_APP_MAIL: "smtp", SMTP_HOST: "" }), [
    "PROVIDER_APP_MAIL lists smtp, but SMTP_HOST is not set",
  ]);
  assert.deepEqual(check({ PROVIDER_AUTH: "better-auth" }, ["AUTH_SECRET"]), [
    "PROVIDER_AUTH lists better-auth, but AUTH_SECRET is not set",
    "AUTH_SECRET is missing or shorter than 32 characters",
  ]);
  assert.deepEqual(check({ PROVIDER_FILES: "s3", S3_BUCKET: "" }), [
    "PROVIDER_FILES lists s3, but S3_BUCKET is not set",
  ]);
  // The relay's login, a pair or neither, and the store's keys, which compose.yaml passes.
  const optional = { SMTP_USER: "", SMTP_PASSWORD: "", S3_ACCESS_KEY: "", S3_SECRET_KEY: "" };
  assert.deepEqual(check(optional), []);
});

test("deploy:check refuses an adapter its port does not have, a name given twice, and a name no enrichment source of the list's kind defines, reading each list as the apps do", () => {
  const unknown = (list: string, name: string) =>
    `${list} lists '${name}', an adapter the registry does not know`;
  assert.deepEqual(check({ PROVIDER_COMPANY_DATA: "wikidata,companies-hous" }), [
    unknown("PROVIDER_COMPANY_DATA", "companies-hous"),
  ]);
  // Another port's adapter, in a list and in the browser's selector; a name no adapter has, in the
  // AI's, LinkedIn's, the files' and the alerts' selectors; the mailbox has the fake alone so far.
  assert.deepEqual(check({ PROVIDER_WEB_SEARCH: "hunter" }), [
    unknown("PROVIDER_WEB_SEARCH", "hunter"),
  ]);
  assert.deepEqual(check({ PROVIDER_BROWSER: "brave" }), [unknown("PROVIDER_BROWSER", "brave")]);
  for (const [key, name] of [
    ["PROVIDER_LLM", "claude"],
    ["PROVIDER_LINKEDIN", "linkedin"],
    ["PROVIDER_FILES", "minio"],
    ["PROVIDER_ALERTS", "slack"],
    ["PROVIDER_MAILBOX", "google"],
    ["PROVIDER_APP_MAIL", "smtp2"],
    ["PROVIDER_AUTH", "authjs"],
  ]) {
    assert.deepEqual(check({ [key]: name }), [unknown(key, name)], key);
  }
  // providerList() trims nothing: a space or an empty name fails the start, so it is refused.
  assert.deepEqual(check({ PROVIDER_EMAIL_VERIFIER: "reoon, zerobounce" }), [
    unknown("PROVIDER_EMAIL_VERIFIER", " zerobounce"),
  ]);
  assert.deepEqual(check({ PROVIDER_EMAIL_FINDER: "hunter,,snov" }), [
    unknown("PROVIDER_EMAIL_FINDER", ""),
  ]);
  assert.deepEqual(check({ PROVIDER_EMAIL_FINDER: "hunter,tomba,hunter" }), [
    "PROVIDER_EMAIL_FINDER lists 'hunter' twice",
  ]);
  // Enrichment's source lists: every name of the table, and none other, trimmed as sourceList()
  // trims them; spaces or commas only are an empty list, its default.
  for (const [list, names] of Object.entries(SOURCE_NAMES)) {
    assert.deepEqual(check({ [list]: names.join(", ") }), [], list);
    assert.deepEqual(check({ [list]: " , " }), [], list);
  }
  const noSource = (list: string, name: string) =>
    `${list} lists '${name}', a name no source of its kind defines`;
  assert.deepEqual(check({ ENRICHMENT_COMPANY_SOURCES: "company-data, linkdin" }), [
    noSource("ENRICHMENT_COMPANY_SOURCES", "linkdin"),
  ]);
  assert.deepEqual(check({ ENRICHMENT_PERSON_SOURCES: "company-data" }), [
    noSource("ENRICHMENT_PERSON_SOURCES", "company-data"),
  ]);
  assert.deepEqual(check({ ENRICHMENT_COMPANY_SOURCES: "company-data,company-data" }), [
    "ENRICHMENT_COMPANY_SOURCES lists 'company-data' twice",
  ]);
  // The email list (gamma-en-080) names sources, never a finder: PROVIDER_EMAIL_FINDER names those.
  assert.deepEqual(check({ ENRICHMENT_EMAIL_SOURCES: "email-finder, hunter" }), [
    noSource("ENRICHMENT_EMAIL_SOURCES", "hunter"),
  ]);
});

test("deploy:check takes every optional selector and enrichment list empty or left out, and refuses any other selector of its table left out as it refuses one empty", () => {
  const optional = Object.keys(ADAPTER_VARIABLES).filter((key) => OPTIONAL_SELECTORS.has(key));
  for (const list of [...optional, ...Object.keys(SOURCE_NAMES)]) {
    assert.deepEqual(check({ [list]: "" }), [], list);
    assert.deepEqual(check({}, [list]), [], list);
  }
  for (const key of Object.keys(ADAPTER_VARIABLES).filter((key) => !OPTIONAL_SELECTORS.has(key))) {
    const finding = `${key} is '': a server runs a real adapter, never the fake`;
    assert.deepEqual(check({ [key]: "" }), [finding], key);
    assert.deepEqual(check({}, [key]), [finding], key);
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

test("deploy:check takes PROVIDER_ALERTS, PROVIDER_BROWSER, PROVIDER_COMPANY_DATA, PROVIDER_EMAIL_FINDER, PROVIDER_EMAIL_VERIFIER, PROVIDER_MAILBOX and PROVIDER_WEB_SEARCH empty, never fake; any other selector empty is refused", () => {
  // Empty, alerts has no team channel, the browser none, company data no source, the email finder
  // none, the email verifier none, the mailbox port picks each mailbox's own provider, and web
  // search has no search.
  const optional = ["PROVIDER_ALERTS", "PROVIDER_BROWSER", "PROVIDER_COMPANY_DATA"];
  for (const key of [
    ...optional,
    "PROVIDER_EMAIL_FINDER",
    "PROVIDER_EMAIL_VERIFIER",
    "PROVIDER_MAILBOX",
    "PROVIDER_WEB_SEARCH",
  ]) {
    assert.deepEqual(check({ [key]: "" }), [], key);
    refuses(check({ [key]: "fake" }), key);
  }
  // A list of adapters holds no fake either, wherever it stands.
  assert.deepEqual(check({ PROVIDER_COMPANY_DATA: "wikidata,companies-house" }), []);
  for (const list of ["wikidata,fake", "fake,wikidata", "wikidata,fake,companies-house"]) {
    refuses(check({ PROVIDER_COMPANY_DATA: list }), "PROVIDER_COMPANY_DATA");
  }
  refuses(check({ PROVIDER_EMAIL_FINDER: "hunter,fake" }), "PROVIDER_EMAIL_FINDER");
  refuses(check({ PROVIDER_EMAIL_VERIFIER: "fake,reoon" }), "PROVIDER_EMAIL_VERIFIER");
  // Three selectors of the example, and one it does not have, added at the end of the file.
  for (const key of ["PROVIDER_LLM", "PROVIDER_LINKEDIN", "PROVIDER_FILES", "PROVIDER_NEXT_PORT"]) {
    refuses(check({ [key]: "" }), key);
  }
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
