// `pnpm unipile:webhooks <command> [--env-file <path>]` (docs/runbook.md "LinkedIn webhooks"): sets
// up the three Unipile webhooks of the adapter's README ("Webhooks") from the env file's UNIPILE_
// variables. Plain Node, no dependency, run as deploy:check is, or in its `docker run` form with
// the network on. The file is read as text with deploy:check's parseEnv, never sourced, and only
// its path is printed. The key, the two secrets, a webhook's headers and Unipile's bodies never
// reach the output: an error is its HTTP status and Unipile's short error type, as the adapter's
// are. Requests go to UNIPILE_BASE_URL only, https, with fetch, a redirect never followed, 30
// seconds at most. Exit 0 done; 1 a finding or a Unipile error; 2 a usage error.
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  COMMANDS,
  ERROR_TYPE,
  LIST_PAGE,
  LIST_PAGES_MAX,
  MAX_ANSWER_BYTES,
  NETWORK_CODE,
  NOTIFY_PATH,
  REDIRECT_STATUS,
  SECRET_MIN_CHARS,
  TEST_HTTP_HOST,
  TEST_HTTP_SWITCH,
  TIMEOUT_MS,
  UNIPILE_ADAPTER,
  UNIPILE_API,
  WEBHOOK_FORMAT,
  WEBHOOK_HEADER,
  WEBHOOK_PREFIX,
  WEBHOOK_SOURCES,
  WEBHOOKS_ROUTE,
} from "./constants.ts";
import { parseEnv } from "./deploy-check.ts";

type Command = (typeof COMMANDS)[number];
type Env = Map<string, string>;
/** A webhook as Unipile lists it: these three fields and nothing else, its headers never read. */
type Webhook = { id: string; name: string; url: string };
type Request = { verb: "GET" | "POST" | "DELETE"; path: string; query?: string; body?: unknown };

const NAME = "unipile:webhooks";
const USAGE = `Usage: pnpm ${NAME} <command> [--env-file <path>]

  check     the UNIPILE_ variables, then one listing that proves the key, and the whytide-* webhooks
  list      every webhook's id, name and URL, never its headers
  register  replaces whytide-messaging, whytide-users and whytide-account_status: safe to run again
  remove    removes those three webhooks and no other

The env file: --env-file <path>, else .env.local at the repository root, else deploy/.env.`;
const OURS = WEBHOOK_SOURCES.map(({ source }) => `${WEBHOOK_PREFIX}${source}`);
/** The variables each command uses: check every one; the cursor secret is check's only. */
const BASE = ["UNIPILE_BASE_URL", "UNIPILE_API_KEY"];
const NEEDS: Record<Command, readonly string[]> = {
  check: [...BASE, "UNIPILE_WEBHOOK_SECRET", "UNIPILE_NOTIFY_URL", "UNIPILE_CURSOR_SECRET"],
  list: BASE,
  register: [...BASE, "UNIPILE_WEBHOOK_SECRET", "UNIPILE_NOTIFY_URL"],
  remove: BASE,
};

/** A run's end: the line said, and the exit code. */
class Stop extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}
const usageError = (message: string) => new Stop(`${message}\n${USAGE}`, 2);

const say = (line: string) => console.log(`${NAME}: ${line}`);
const warn = (line: string) => console.error(`${NAME}: ${line}`);
/** A string of Unipile's as one printable line: a control character could rewrite the terminal. */
const shown = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
const describe = ({ id, name, url }: Webhook) => `  ${shown(id)}  ${shown(name)}  ${shown(url)}`;

/** The command and the env file asked for; a usage error for anything else. */
export function parseArgs(args: readonly string[]): { command?: Command; envFile?: string } {
  if (args.includes("--help") || args.includes("-h")) return {};
  let command: Command | undefined;
  let envFile: string | undefined;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? "";
    if (arg === "--env-file" || arg.startsWith("--env-file=")) {
      envFile = arg === "--env-file" ? args[++at] : arg.slice("--env-file=".length);
      if (envFile === undefined || envFile === "") throw usageError("--env-file needs a path");
    } else if (arg.startsWith("-")) {
      throw usageError(`unknown option '${shown(arg)}'`);
    } else if (command !== undefined) {
      throw usageError(`one command at a time: '${shown(arg)}' after ${command}`);
    } else if (COMMANDS.includes(arg as Command)) {
      command = arg as Command;
    } else {
      throw usageError(`unknown command '${shown(arg)}'`);
    }
  }
  if (command === undefined) throw usageError("no command");
  return { command, envFile };
}

/** --env-file when given, else .env.local at the repository root if it exists, else deploy/.env. */
export function envFileOf(given: string | undefined, root: string): string {
  if (given !== undefined) return resolve(given);
  const local = join(root, ".env.local");
  return existsSync(local) ? local : join(root, "deploy", ".env");
}

const isHttps = (url: URL | null) => url?.protocol === "https:";

/** What is wrong with one variable, or undefined when it is fine; names only, never a value. */
function wrongWith(key: string, value: string, testHttp: boolean): string | undefined {
  if (value === "") return "is missing";
  const url = URL.parse(value);
  switch (key) {
    case "UNIPILE_BASE_URL": {
      const local = testHttp && url?.protocol === "http:" && url.hostname === TEST_HTTP_HOST;
      return isHttps(url) || local
        ? undefined
        : "is not an https address: the key goes to https only";
    }
    case "UNIPILE_NOTIFY_URL":
      if (!isHttps(url)) return "is not an https address";
      return url?.pathname.endsWith(NOTIFY_PATH)
        ? undefined
        : `has a path not ending in ${NOTIFY_PATH}`;
    case "UNIPILE_WEBHOOK_SECRET":
    case "UNIPILE_CURSOR_SECRET":
      return value.length >= SECRET_MIN_CHARS
        ? undefined
        : `is shorter than ${SECRET_MIN_CHARS} characters`;
    default:
      return undefined;
  }
}

const FINE: Record<string, string> = {
  UNIPILE_BASE_URL: "is an https address",
  UNIPILE_API_KEY: "is set",
  UNIPILE_WEBHOOK_SECRET: `is ${SECRET_MIN_CHARS} characters or more`,
  UNIPILE_NOTIFY_URL: `is https, its path ending in ${NOTIFY_PATH}`,
  UNIPILE_CURSOR_SECRET: `is ${SECRET_MIN_CHARS} characters or more`,
};

/** The variables the command uses, a line each when `verbose` (check), the wrong ones always. */
function checkVariables(env: Env, command: Command, verbose: boolean): void {
  const testHttp = process.env[TEST_HTTP_SWITCH] === "1";
  let wrong = 0;
  for (const key of NEEDS[command]) {
    const problem = wrongWith(key, env.get(key) ?? "", testHttp);
    if (problem !== undefined) warn(`wrong: ${key} ${problem}`);
    else if (verbose) say(`ok: ${key} ${FINE[key]}`);
    if (problem !== undefined) wrong++;
  }
  if (verbose && env.get("PROVIDER_LINKEDIN") !== UNIPILE_ADAPTER) {
    warn(`warning: PROVIDER_LINKEDIN is not ${UNIPILE_ADAPTER}: the apps do not use Unipile`);
  }
  if (wrong > 0) throw new Stop(`${wrong} wrong: nothing was sent to Unipile`, 1);
}

/** One request to UNIPILE_BASE_URL: the answer's JSON, or a Stop with its status and type. */
async function call(env: Env, request: Request): Promise<unknown> {
  const url = new URL(`${UNIPILE_API}${request.path}`, env.get("UNIPILE_BASE_URL"));
  if (request.query !== undefined) url.search = request.query;
  const what = `${request.verb} ${UNIPILE_API}${request.path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-api-key": env.get("UNIPILE_API_KEY") ?? "",
  };
  if (request.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: request.verb,
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await answerOf(what, response);
  } catch (error) {
    throw error instanceof Stop ? error : unanswered(what, error);
  }
  if (!response.ok) {
    const type = errorType(text);
    throw new Stop(`${what}: Unipile answered ${response.status}${type ? ` ${type}` : ""}`, 1);
  }
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Stop(`${what}: Unipile answered ${response.status}, not JSON`, 1);
  }
}

/** The answer's text, up to MAX_ANSWER_BYTES; a redirect's or a longer one's is never read. */
async function answerOf(what: string, response: Response): Promise<string> {
  const { status } = response;
  const refuse = async (reason: string) => {
    await response.body?.cancel().catch(() => undefined);
    return new Stop(`${what}: Unipile answered ${status}, ${reason}`, 1);
  };
  if (status >= REDIRECT_STATUS.min && status <= REDIRECT_STATUS.max) {
    throw await refuse("a redirect, not followed");
  }
  if (Number(response.headers.get("content-length")) > MAX_ANSWER_BYTES) {
    throw await refuse("an answer too large");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_ANSWER_BYTES) throw await refuse("an answer too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A request with no answer: past the timeout, else unreachable with the error's short code. */
function unanswered(what: string, error: unknown): Stop {
  if ((error as { name?: unknown } | null)?.name === "TimeoutError") {
    return new Stop(`${what}: no answer in ${TIMEOUT_MS / 1000} seconds`, 1);
  }
  const code = (error as { cause?: { code?: unknown } | null } | null)?.cause?.code;
  const known = typeof code === "string" && NETWORK_CODE.test(code);
  return new Stop(`${what}: Unipile is unreachable${known ? ` (${code})` : ""}`, 1);
}

/** Unipile's short error type, `errors/<reason>`, and nothing else of the body. */
function errorType(text: string): string | undefined {
  try {
    const { type } = JSON.parse(text) as { type?: unknown };
    return typeof type === "string" && ERROR_TYPE.test(type) ? type : undefined;
  } catch {
    return undefined;
  }
}

const offShape = () => new Stop(`GET ${UNIPILE_API}${WEBHOOKS_ROUTE}: an answer off its shape`, 1);

/** Every webhook of the account, page by page: the three fields of each, never its headers. */
async function listWebhooks(env: Env): Promise<Webhook[]> {
  const found: Webhook[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGES_MAX; page++) {
    const query = new URLSearchParams({ limit: String(LIST_PAGE) });
    if (cursor !== undefined) query.set("cursor", cursor);
    const answer = await call(env, { verb: "GET", path: WEBHOOKS_ROUTE, query: query.toString() });
    const { items, cursor: next } = (answer ?? {}) as { items?: unknown; cursor?: unknown };
    if (!Array.isArray(items)) throw offShape();
    found.push(...items.map(webhookOf));
    if (typeof next !== "string" || next === "") return found;
    cursor = next;
  }
  throw new Stop(`GET ${UNIPILE_API}${WEBHOOKS_ROUTE}: more than ${LIST_PAGES_MAX} pages`, 1);
}

function webhookOf(item: unknown): Webhook {
  if (typeof item !== "object" || item === null) throw offShape();
  const field = (key: string) => {
    const value = (item as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  };
  return {
    id: field("id"),
    name: field("name"),
    url: field("request_url"),
  };
}

/** Removes the three webhooks of our names, and never one of another name. */
async function removeOurs(env: Env, webhooks: readonly Webhook[]): Promise<void> {
  const ours = webhooks.filter(({ name }) => OURS.includes(name));
  for (const webhook of ours) {
    if (webhook.id === "" || webhook.id === "." || webhook.id === "..") {
      throw new Stop(`${webhook.name} has no id Unipile can delete it by`, 1);
    }
    const path = `${WEBHOOKS_ROUTE}/${encodeURIComponent(webhook.id)}`;
    await call(env, { verb: "DELETE", path });
    say(`removed ${shown(webhook.name)} (${shown(webhook.id)})`);
  }
  if (ours.length === 0) say(`no ${WEBHOOK_PREFIX}* webhook of the three to remove`);
}

/** Creates the three: the notify URL, json, their events, the secret as the Unipile-Auth header. */
async function createOurs(env: Env): Promise<void> {
  for (const { source, events } of WEBHOOK_SOURCES) {
    const name = `${WEBHOOK_PREFIX}${source}`;
    const body = {
      source,
      name,
      request_url: env.get("UNIPILE_NOTIFY_URL"),
      format: WEBHOOK_FORMAT,
      events,
      headers: [{ key: WEBHOOK_HEADER, value: env.get("UNIPILE_WEBHOOK_SECRET") }],
    };
    await call(env, { verb: "POST", path: WEBHOOKS_ROUTE, body });
    say(`created ${name}`);
  }
}

/** Each of the three, once, at UNIPILE_NOTIFY_URL: the names that are not. */
function missing(env: Env, webhooks: readonly Webhook[]): string[] {
  const notify = env.get("UNIPILE_NOTIFY_URL");
  return OURS.filter(
    (name) => webhooks.filter((hook) => hook.name === name && hook.url === notify).length !== 1,
  );
}

async function run(command: Command, env: Env): Promise<void> {
  checkVariables(env, command, command === "check");
  const before = await listWebhooks(env);
  if (command === "list") {
    say(`${before.length} webhooks: id, name, URL`);
    for (const webhook of before) say(describe(webhook));
    return;
  }
  if (command === "check") {
    const ours = before.filter(({ name }) => name.startsWith(WEBHOOK_PREFIX));
    say(`ok: the key works: Unipile lists ${before.length} webhooks`);
    say(`${ours.length} ${WEBHOOK_PREFIX}* webhooks: id, name, URL`);
    for (const webhook of ours) say(describe(webhook));
    const absent = missing(env, ours);
    if (absent.length > 0) {
      warn(`warning: not once at UNIPILE_NOTIFY_URL: ${absent.join(", ")}: run register`);
    }
    return;
  }
  await removeOurs(env, before);
  if (command === "remove") return;
  await createOurs(env);
  const ours = (await listWebhooks(env)).filter(({ name }) => name.startsWith(WEBHOOK_PREFIX));
  say(`${ours.length} ${WEBHOOK_PREFIX}* webhooks: id, name, URL`);
  for (const webhook of ours) say(describe(webhook));
  const absent = missing(env, ours);
  if (absent.length > 0) throw new Stop(`Unipile does not list ${absent.join(", ")} once`, 1);
}

/** The whole run: the exit code. */
export async function main(args: readonly string[], root: string): Promise<number> {
  try {
    const { command, envFile } = parseArgs(args);
    if (command === undefined) {
      console.log(USAGE);
      return 0;
    }
    const file = envFileOf(envFile, root);
    const name = relative(process.cwd(), file) || file;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new Stop(`no ${name}: name one with --env-file, or fill .env.local or deploy/.env`, 1);
    }
    say(`read ${name}`);
    await run(command, parseEnv(text));
    return 0;
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    warn(error.message);
    return error.code;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), join(import.meta.dirname, "..", ".."));
}
