// `pnpm deploy:check [file]` (README.md "Production"): refuses an environment file that is not fit for
// a server, deploy/.env by default, before `docker compose up -d`. One line per finding and exit 1;
// exit 0 when it is fit. Plain Node, no dependency; the rules are exported for its unit test. A list
// is read as the apps read it, so that a file deploy:check takes also starts: every PROVIDER_
// selector and list names only adapters of its port, each with the variables it cannot run without
// (gamma-en-100), and enrichment's source lists only names its sources define, each once
// (constants.ts holds both tables).
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ADAPTER_VARIABLES,
  FAKE,
  LIST_SEPARATOR,
  OPTIONAL_SELECTORS,
  SOURCE_NAMES,
} from "./constants.ts";

/**
 * An environment file as Compose reads it: KEY=value, a value in quotes, or bare up to a ` #`
 * comment, so `KEY= # x` is the value `# x`, as Compose gives it to the apps. No `$` is expanded.
 */
export function parseEnv(text: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    const raw = (match[2] ?? "").trimEnd();
    const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(raw);
    env.set(match[1], quoted ? (quoted[2] ?? "") : (raw.split(" #")[0] ?? "").trimEnd());
  }
  return env;
}

/**
 * The values on deploy/.env.example's lines that end in `# secret`, read without the marker:
 * development's examples. `KEY= # secret` has none.
 */
export function developmentSecrets(example: string): Map<string, string> {
  const secrets = new Map<string, string>();
  for (const line of example.split("\n")) {
    const assignment = /^(.*?)\s*#\s*secret\s*$/.exec(line)?.[1];
    if (assignment === undefined) continue;
    for (const [key, value] of parseEnv(assignment)) if (value !== "") secrets.set(key, value);
  }
  return secrets;
}

/** A PROVIDER_ list's names as providers' providerList() reads them: nothing trimmed; empty, none. */
const adapterNames = (value: string) => (value === "" ? [] : value.split(LIST_SEPARATOR));

/** An enrichment list's names as its sourceList() reads them: trimmed, an empty one dropped. */
const sourceNames = (value: string) =>
  value
    .split(LIST_SEPARATOR)
    .map((name) => name.trim())
    .filter((name) => name !== "");

/** Each name a list gives more than once. */
const twice = (names: readonly string[]) => [
  ...new Set(names.filter((name, at) => names.indexOf(name) !== at)),
];

const isHttps = (value: string) => URL.parse(value)?.protocol === "https:";
const keyBytes = (value: string) => Buffer.from(value, "base64");
const isMasterKey = (value: string) =>
  /^[A-Za-z0-9+/]{43}=$/.test(value) && keyBytes(value).length === 32;

/** The findings, one line each; none when `env` is fit for a server. */
export function checkDeploy(env: Map<string, string>, example: string): string[] {
  const findings: string[] = [];
  const get = (key: string) => env.get(key) ?? "";
  const development = parseEnv(example);

  const appEnv = get("APP_ENV");
  if (appEnv !== "production") {
    findings.push(`APP_ENV is '${appEnv}': a server runs production, never development or test`);
  }
  // The file's selectors and every one of the table, so that one left out is read as empty.
  const selectors = new Set([...env.keys(), ...Object.keys(ADAPTER_VARIABLES)]);
  for (const key of selectors) {
    if (!/^PROVIDER_[A-Z_]+$/.test(key)) continue;
    const value = get(key);
    // A selector names one adapter, a list several, separated by commas: the fake in neither.
    if (
      value.split(LIST_SEPARATOR).includes(FAKE) ||
      (value === "" && !OPTIONAL_SELECTORS.has(key))
    ) {
      findings.push(`${key} is '${value}': a server runs a real adapter, never the fake`);
    }
  }
  // Each adapter a selector or a list names: one of the port's, with every variable it cannot run
  // without; the fake is refused above. Names only, never a value.
  for (const [key, adapters] of Object.entries(ADAPTER_VARIABLES)) {
    const names = adapterNames(get(key));
    for (const name of twice(names)) findings.push(`${key} lists '${name}' twice`);
    for (const name of new Set(names)) {
      if (name === FAKE) continue;
      const variables = Object.hasOwn(adapters, name) ? adapters[name] : undefined;
      if (variables === undefined) {
        findings.push(`${key} lists '${name}', an adapter the registry does not know`);
      }
      for (const variable of variables ?? []) {
        if (get(variable) === "") findings.push(`${key} lists ${name}, but ${variable} is not set`);
      }
    }
  }
  // Enrichment's source lists: each name one of its sources of the list's kind.
  for (const [key, known] of Object.entries(SOURCE_NAMES)) {
    const names = sourceNames(get(key));
    for (const name of twice(names)) findings.push(`${key} lists '${name}' twice`);
    for (const name of new Set(names)) {
      if (!known.includes(name)) {
        findings.push(`${key} lists '${name}', a name no source of its kind defines`);
      }
    }
  }
  if (!isMasterKey(get("APP_MASTER_KEY"))) {
    findings.push("APP_MASTER_KEY is missing or not 32 bytes in base64: `pnpm secrets:keygen`");
  }
  const previous = get("APP_MASTER_KEY_PREVIOUS");
  if (previous !== "" && !isMasterKey(previous)) {
    findings.push("APP_MASTER_KEY_PREVIOUS is not 32 bytes in base64");
  } else if (previous !== "" && keyBytes(previous).equals(keyBytes(get("APP_MASTER_KEY")))) {
    findings.push(
      "APP_MASTER_KEY_PREVIOUS is the same key as APP_MASTER_KEY: the key before a rotation",
    );
  }
  for (const key of ["AUTH_SECRET", "HASH_SALT"]) {
    if (get(key).length < 32) findings.push(`${key} is missing or shorter than 32 characters`);
  }
  if (!isHttps(get("AUTH_BASE_URL"))) {
    findings.push(`AUTH_BASE_URL is '${get("AUTH_BASE_URL")}': sign-in links open on https: only`);
  }
  if (get("APP_DOMAIN") === "") findings.push("APP_DOMAIN is empty: Caddy needs the app's name");
  if (get("CADDY_INTERNAL_TLS") === "1") {
    findings.push("CADDY_INTERNAL_TLS is 1: Caddy's own authority is for the test run only");
  }
  if (get("EGRESS_ALLOW_HOSTS") !== "") {
    findings.push(
      "EGRESS_ALLOW_HOSTS is set: it opens local test servers, and is empty on a server",
    );
  }

  // The development defaults: the example secrets of .env.example, the stack's two passwords, and
  // the stack's password inside a connection string.
  for (const [key, value] of developmentSecrets(example)) {
    if (get(key) === value) findings.push(`${key} is the development example's value`);
  }
  for (const key of ["DEV_POSTGRES_PASSWORD", "DEV_MINIO_ROOT_PASSWORD"]) {
    if (get(key) === "" || get(key) === development.get(key)) {
      findings.push(`${key} is empty or the development stack's password`);
    }
  }
  const stackPassword = development.get("DEV_POSTGRES_PASSWORD");
  for (const key of ["DATABASE_URL_OWNER", "DATABASE_URL", "DATABASE_URL_BILLING_WRITER"]) {
    const url = URL.parse(get(key));
    if (!url || url.password === "") findings.push(`${key} is missing or has no password`);
    else if (url.password === stackPassword) {
      findings.push(`${key} has the development stack's password`);
    }
  }
  return findings;
}

if (import.meta.main) {
  const root = join(import.meta.dirname, "..", "..");
  const file = process.argv[2] ?? join(root, "deploy", ".env");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.error(
      `deploy:check: no ${file}: copy deploy/.env.production.example to it and fill it`,
    );
    process.exit(1);
  }
  const example = readFileSync(join(root, "deploy", ".env.example"), "utf8");
  const findings = checkDeploy(parseEnv(text), example);
  const name = relative(process.cwd(), file) || file;
  for (const finding of findings) console.error(`deploy:check: ${name}: ${finding}`);
  if (findings.length > 0) process.exit(1);
  console.log(`deploy:check: ${name} is fit for a server`);
}
