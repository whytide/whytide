// A vendor on 127.0.0.1 for the company-data adapters' mapping tests (../../README.md "Adapters"): an
// HTTP server that records every request (its method, path, query, headers and body) and plays an
// answer, the one a test queued first, else the one its route gives; an answer can be held, never
// answered, until the adapter gives up. Then what every adapter's tests share: the offline world of
// the contract suite on such a vendor and the answer each of the port's codes comes from; the README's
// mapping fields; the adapter started as a host starts it; the pattern's redirect, bound and timeout;
// a port nothing listens on, for a refused connection; the failures logged and the check that no
// value leaked. Nothing here reaches past 127.0.0.1.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { inspect, promisify } from "node:util";
import { collectLogs, createLogger, isAppError } from "@whytide/platform";
import {
  type CompanyDataFailure,
  type OfflineWorld,
  PROVIDER_ERROR_STATUS,
  RETRY_AFTER_SEC,
  type WorldCompany,
} from "../../contract.ts";
import type { CompanyLookup } from "../../port.ts";

export type Answer = {
  /** 200 unless given. */
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Sent as JSON, or as it is when a string. */
  readonly body?: unknown;
  /** No answer at all: the request is held until the adapter gives up. */
  readonly silent?: boolean;
};

export type Received = {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  /** The URL as the request line gave it, query included. */
  readonly url: string;
};

const LOCAL = "127.0.0.1";

/** The vendor on a free port of 127.0.0.1, answering by `route` unless a test queued an answer. */
export async function startVendor(route: (request: Received) => Answer) {
  const requests: Received[] = [];
  const queued: Answer[] = [];
  const held = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const url = new URL(request.url ?? "/", `http://${LOCAL}`);
    const received: Received = {
      method: request.method ?? "",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
      url: request.url ?? "",
    };
    requests.push(received);
    const answer = queued.shift() ?? route(received);
    response.on("error", () => undefined);
    if (answer.silent) return void held.add(response);
    const body = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? {});
    response.writeHead(answer.status ?? 200, {
      "content-type": "application/json",
      ...answer.headers,
    });
    // Written, then ended: sent in chunks, with no length for the adapter to read first.
    response.write(body);
    response.end();
  });
  server.listen(0, LOCAL);
  await once(server, "listening");
  return {
    origin: `http://${LOCAL}:${(server.address() as AddressInfo).port}`,
    requests,
    answerNext: (answer: Answer) => void queued.push(answer),
    close: async () => {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

export type Vendor = Awaited<ReturnType<typeof startVendor>>;

/** An origin on a port of 127.0.0.1 nothing listens on: a refused connection. */
export async function closedOrigin(): Promise<string> {
  const server = createServer().listen(0, LOCAL);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return `http://${LOCAL}:${port}`;
}

/** The answer each of the port's codes comes from, as every vendor's status says it. */
export const FAILURES: Readonly<Record<CompanyDataFailure, Answer>> = {
  company_data_rate_limited: { status: 429, headers: { "retry-after": String(RETRY_AFTER_SEC) } },
  company_data_allowance_spent: { status: 402 },
  company_data_unauthorized: { status: 401 },
  company_data_provider_error: { status: PROVIDER_ERROR_STATUS },
};

/** The contract's offline world on a vendor: its company, an unknown one, its failures, its calls. */
export const vendorWorld = (
  vendor: Vendor,
  company: WorldCompany,
  unknown: CompanyLookup,
  failures: Readonly<Record<CompanyDataFailure, Answer>> = FAILURES,
): OfflineWorld => ({
  live: false,
  company: () => company,
  unknown: () => unknown,
  failNext: (code) => vendor.answerNext(failures[code]),
  calls: () => vendor.requests.length,
});

/** Which of `values` appear, in any case, in everything `seen` holds, its hidden fields included. */
export function leaked(values: readonly string[], seen: unknown): string[] {
  const text = inspect(seen, { depth: Number.POSITIVE_INFINITY, showHidden: true }).toLowerCase();
  return values.filter((value) => text.includes(value.toLowerCase()));
}

/** The port's fields the README's "Mapping" table maps to: its second column, in backticks. */
export function mappedFields(readme: string): string[] {
  const section = readme.split(/^## /m).find((part) => part.startsWith("Mapping")) ?? "";
  return [...section.matchAll(/^\|[^|\n]*\| `(\w+)` \|/gm)].map(([, field]) => field ?? "");
}

/**
 * The adapter `name` of `module` as a host starts it, in a child process with `env` added: its
 * declarations, and its create()'s outcome, `created` or the code it fails with.
 */
export async function startedIn(module: string, name: string, env: Record<string, string>) {
  const script = [
    `const adapter = (await import(${JSON.stringify(module)}))[${JSON.stringify(name)}];`,
    "let created;",
    "try { adapter.create(); created = 'created'; } catch (error) { created = error.code; }",
    "const { openData, allowance } = adapter;",
    "console.log(JSON.stringify({ openData, allowance, created }));",
  ].join("\n");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    { env: { ...process.env, APP_ENV: "test", ...env } },
  );
  return JSON.parse(stdout) as { openData: boolean; allowance: unknown; created: string };
}

const providerErrorWith = (details: Record<string, unknown>) => (error: unknown) => {
  assert.ok(isAppError(error) && error.code === "company_data_provider_error", String(error));
  assert.deepEqual(error.details, details);
  return true;
};

/**
 * The pattern every adapter keeps, on `lookup()`'s first request: a redirect never followed, an
 * answer past `maxBytes` never read whole, no answer within `timeoutMs` given up; each one
 * company_data_provider_error with its reason. The adapter's timer, asked for `timeoutMs`, fires
 * after 50 ms here.
 */
export async function checkPattern(
  t: TestContext,
  vendor: Vendor,
  lookup: () => Promise<unknown>,
  { maxBytes, timeoutMs }: { readonly maxBytes: number; readonly timeoutMs: number },
): Promise<void> {
  const first = vendor.requests.length;
  vendor.answerNext({ status: 302, headers: { location: `${vendor.origin}/followed` } });
  await assert.rejects(lookup(), providerErrorWith({ status: 302, reason: "redirect" }));
  assert.equal(vendor.requests.length - first, 1, "the redirect not followed");
  vendor.answerNext({ body: "x".repeat(maxBytes + 1) });
  await assert.rejects(lookup(), providerErrorWith({ status: 200, reason: "answer_too_large" }));
  const asked: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    asked.push(ms);
    return timeout(50);
  });
  vendor.answerNext({ silent: true });
  await assert.rejects(lookup(), providerErrorWith({ reason: "timeout" }));
  assert.deepEqual(asked, [timeoutMs]);
}

/**
 * Each lookup failed by each answer, each error logged as a caller logs it: the errors and the log
 * lines, for leaked() to search.
 */
export async function failuresSeen(
  adapter: { readonly lookupCompany: (lookup: CompanyLookup) => Promise<unknown> },
  vendor: Vendor,
  lookups: readonly CompanyLookup[],
  answers: readonly Answer[],
): Promise<unknown[]> {
  const logs = collectLogs();
  const logger = createLogger({ destination: logs.destination });
  const errors: unknown[] = [];
  for (const answer of answers) {
    for (const lookup of lookups) {
      vendor.answerNext(answer);
      await adapter.lookupCompany(lookup).then(
        () => assert.fail("the lookup was to fail"),
        (error: unknown) => {
          assert.ok(isAppError(error), String(error));
          errors.push(error);
          logger.error({ err: error }, "company lookup failed");
        },
      );
    }
  }
  return [errors, logs.raw];
}
