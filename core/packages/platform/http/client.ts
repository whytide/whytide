// fetchSafe (alpha-p1-065): the one way server code fetches a URL (docs/rules/security.md §5). Each
// hop runs checkUrl, resolves the host once and refuses the hop when any address is blocked, then
// connects only to those addresses: the socket's lookup answers them whatever it is asked, so no
// second resolution can rebind the name, while the Host header, TLS SNI and the certificate check
// keep the original host name. GET only; every redirect hop runs every check again; the body and
// the whole call are bounded. The errors carry no URL; the span carries the host, never the path or
// the query, and the HTTP instrumentation is kept out of the client's requests.
import { Resolver as DnsResolver } from "node:dns/promises";
import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP, type LookupFunction, type Socket } from "node:net";
import { urlToHttpOptions } from "node:url";
import { context } from "@opentelemetry/api";
import { core } from "@opentelemetry/sdk-node";
import { platformConfig } from "../config/platform.ts";
import { AppError, isAppError } from "../errors/index.ts";
import { withSpan } from "../telemetry/index.ts";
import { isBlockedAddress } from "./address.ts";
import { egressConfig, fetchSafeConfig, MAX_BODY_BYTES, MAX_TIMEOUT_MS } from "./config.ts";
import { egressErrors } from "./errors.ts";
import { canonicalHost } from "./hosts.ts";
import { allowsBlockedAddress, checkUrl, type EgressLists } from "./url.ts";

/** The addresses of a host name: DNS by default, a stub in a test; the signal is the deadline's. */
export type Resolver = (host: string, signal: AbortSignal) => Promise<readonly string[]>;

export type FetchSafeOptions = {
  readonly method?: "GET";
  /** The body's bytes as received, never decoded; EGRESS_DEFAULT_MAX_BYTES by default. */
  readonly maxBytes?: number;
  /** Past maxBytes, the first maxBytes bytes and `truncated: true` instead of egress_too_large. */
  readonly truncate?: boolean;
  /** The whole call: every hop, its resolution and the body; EGRESS_DEFAULT_TIMEOUT_MS by default. */
  readonly timeoutMs?: number;
  /** The redirects followed at most; one more is refused, so 0 refuses the first. */
  readonly maxRedirects: number;
  /**
   * Past maxRedirects, the redirect itself instead of egress_too_many_redirects: its status and
   * headers, `location` included as sent, unfollowed and unchecked. The Location is the caller's
   * to check; to fetch it, the caller calls fetchSafe again.
   */
  readonly returnRedirect?: boolean;
  readonly accept?: string;
  /**
   * Narrows the operator's lists: denyHosts adds to EGRESS_DENY_HOSTS; allowHosts, for a test's
   * local server, replaces EGRESS_ALLOW_HOSTS and is egress_invalid_options in production.
   */
  readonly lists?: EgressLists;
  /** Supplies addresses only: every check runs on what it returns. */
  readonly resolve?: Resolver;
};

export type FetchSafeResponse = {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  /** Whether the body was cut at maxBytes, which only `truncate: true` allows. */
  readonly truncated: boolean;
  /** The URL that answered, after the redirects. */
  readonly finalUrl: string;
  /** The redirects followed. */
  readonly hops: number;
};

type Settings = {
  readonly maxBytes: number;
  readonly truncate: boolean;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly returnRedirect: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly lists: EgressLists;
  readonly resolve: Resolver;
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** What the status line, the headers and the chunk framing may add on the wire to 2 × maxBytes. */
const WIRE_SLACK = 65_536;
/** The TLS session tickets one connection may bring: a server sends one or two. */
const MAX_TICKETS = 8;
/** Node's default, fixed here so that no --max-http-header-size raises it. */
const MAX_HEADER_BYTES = 16_384;
const NODE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** RFC 6761 §6.3: localhost and every name under it are loopback, and DNS is not asked. */
const LOOPBACK = ["127.0.0.1", "::1"];

/**
 * DNS through c-ares, A and AAAA, cancelled at the deadline: off libuv's thread pool, so a query
 * that never returns holds nothing, where getaddrinfo would hold a thread of the pool for its
 * retries and stall every other lookup of the process. A query unanswered after a quarter to a half
 * of the call is sent again, so a lost packet costs a retry and not the call; once one family has
 * answered, the other gets 50 ms more (RFC 8305 §3). /etc/hosts is not read: a block there does not
 * apply, EGRESS_DENY_HOSTS does.
 */
function dnsResolver(timeoutMs: number): Resolver {
  return async (host, signal) => {
    if (host === "localhost" || host.endsWith(".localhost")) return LOOPBACK;
    signal.throwIfAborted();
    const resolver = new DnsResolver({ timeout: Math.max(Math.floor(timeoutMs / 4), 1), tries: 2 });
    const cancel = () => resolver.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    let late: NodeJS.Timeout | undefined;
    try {
      const queries = [resolver.resolve4(host), resolver.resolve6(host)];
      Promise.any(queries).then(
        () => {
          late = setTimeout(cancel, 50);
        },
        () => {},
      );
      const answers = await Promise.allSettled(queries);
      const found = answers.flatMap((answer) =>
        answer.status === "fulfilled" ? answer.value : [],
      );
      const failed = answers.find((answer) => answer.status === "rejected");
      if (found.length > 0 || failed === undefined) return found;
      throw failed.reason;
    } finally {
      clearTimeout(late);
      signal.removeEventListener("abort", cancel);
    }
  };
}

/** GETs the URL under the egress rules; refusals and failures are AppErrors with an egress code. */
export function fetchSafe(
  input: string | URL,
  options: FetchSafeOptions,
): Promise<FetchSafeResponse> {
  return withSpan("egress.fetch", {}, async (span) => {
    const settings = settle(options);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), settings.timeoutMs);
    const started = performance.now();
    try {
      // A copy of its own: a URL object the caller holds could change between a check and the use.
      let url = checkUrl(String(input), settings.lists);
      // The host is the one attribute outside the log schema: the span names where the call went,
      // and a log line never carries a host. The path and the query never reach the span.
      span.setAttribute("host", url.hostname);
      for (let hops = 0; ; hops += 1) {
        const response = await get(url, settings, deadline.signal);
        const location = response.headers.location;
        const status = response.statusCode ?? 0;
        // With returnRedirect, the redirect past maxRedirects is answered as a final response is:
        // unfollowed, its Location unchecked and the caller's.
        const returned = settings.returnRedirect && hops >= settings.maxRedirects;
        if (!REDIRECTS.has(status) || location === undefined || returned) {
          const { body, truncated } = await readBody(response, settings);
          // The deadline's abort errs the request, which fails a body still arriving; a body that
          // ends as the deadline passes is egress_timeout all the same, never a whole body.
          deadline.signal.throwIfAborted();
          span.setAttributes({ status, response_bytes: body.length, redirect_count: hops });
          return { status, headers: response.headers, body, truncated, finalUrl: url.href, hops };
        }
        // The read that brought this head may have crossed the wire bound: then the response errs
        // with egress_too_large, and is not followed.
        if (response.errored) throw response.errored;
        response.destroy();
        if (hops >= settings.maxRedirects) {
          throw new AppError(egressErrors.egress_too_many_redirects);
        }
        const next = checkUrl(redirectTarget(location, url), settings.lists);
        // No step down: what was asked for over TLS never goes on in clear.
        if (url.protocol === "https:" && next.protocol !== "https:") {
          throw new AppError(egressErrors.egress_insecure_redirect);
        }
        url = next;
      }
    } catch (error) {
      throw deadline.signal.aborted ? new AppError(egressErrors.egress_timeout) : failure(error);
    } finally {
      clearTimeout(timer);
      span.setAttribute("duration_ms", Math.round(performance.now() - started));
    }
  });
}

/** The options with the config's defaults; a bound not a whole number in range fails closed. */
function settle(options: FetchSafeOptions): Settings {
  const bound = (value: number, max: number) => {
    if (Number.isSafeInteger(value) && value >= 0 && value <= max) return value;
    throw new AppError(egressErrors.egress_invalid_options);
  };
  if ((options.method ?? "GET") !== "GET") throw new AppError(egressErrors.egress_invalid_options);
  // A caller narrows the operator's lists and never widens them in production. Each list is read
  // once, so a getter cannot answer the check one thing and the use another.
  const { allowHosts, denyHosts = [] } = options.lists ?? {};
  if (allowHosts !== undefined && platformConfig.APP_ENV === "production") {
    throw new AppError(egressErrors.egress_invalid_options);
  }
  const { EGRESS_DEFAULT_MAX_BYTES, EGRESS_DEFAULT_TIMEOUT_MS } = fetchSafeConfig;
  const timeoutMs = bound(options.timeoutMs ?? EGRESS_DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  return {
    maxBytes: bound(options.maxBytes ?? EGRESS_DEFAULT_MAX_BYTES, MAX_BODY_BYTES),
    truncate: options.truncate === true,
    timeoutMs,
    maxRedirects: bound(options.maxRedirects, Number.MAX_SAFE_INTEGER),
    returnRedirect: options.returnRedirect === true,
    // identity: the body arrives as sent and is never inflated, so maxBytes bounds what is held.
    headers: {
      "accept-encoding": "identity",
      ...(options.accept === undefined ? {} : { accept: options.accept }),
    },
    lists: {
      allowHosts: allowHosts ?? egressConfig.EGRESS_ALLOW_HOSTS,
      denyHosts: [...egressConfig.EGRESS_DENY_HOSTS, ...denyHosts],
    },
    resolve: options.resolve ?? dnsResolver(timeoutMs),
  };
}

/**
 * One GET to the addresses checked for this hop, over a connection of its own (`agent: false`: no
 * pool, no socket another call opened, no proxy). The host name stays the URL's, so Node sends it
 * as the Host header and the TLS server name and checks the certificate against it, whatever
 * NODE_TLS_REJECT_UNAUTHORIZED says; only the lookup is ours. The parser stays strict and the
 * headers small whatever the process's flags say.
 */
async function get(url: URL, settings: Settings, signal: AbortSignal): Promise<IncomingMessage> {
  const lookup = pinnedTo(await checkedAddresses(url, settings, signal));
  const options = {
    ...urlToHttpOptions(url),
    method: "GET",
    headers: settings.headers,
    lookup,
    agent: false,
    rejectUnauthorized: true,
    insecureHTTPParser: false,
    maxHeaderSize: MAX_HEADER_BYTES,
    signal,
  };
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    let answered: IncomingMessage | undefined;
    const respond = (message: IncomingMessage) => {
      answered = message;
      resolve(message);
    };
    // Without tracing: the HTTP instrumentation would export a span with the full URL and send the
    // far end a traceparent. Its duration metric stays, with the method, host, port and status.
    const request = context.with(core.suppressTracing(context.active()), () =>
      url.protocol === "https:" ? https.request(options, respond) : http.request(options, respond),
    );
    // After the head, an error fails a body not yet complete: Node would end a body that only the
    // close delimits as complete on a reset, and a parse error in the read that brought the head
    // would go unseen. A complete body stays whole whatever follows it: no connection is reused.
    request.on("error", (error) => {
      if (answered !== undefined && !answered.complete) answered.destroy(error);
      reject(error);
    });
    // Closed with no response, the request still settles: Node closes the socket of a 101 Switching
    // Protocols answer, which no 'upgrade' listener takes, and emits neither. A no-op afterwards.
    request.on("close", () => reject(new AppError(egressErrors.egress_request_failed)));
    // Every byte read off the socket counts, from the first: blank lines before the status line,
    // 1xx heads, the head, the framing and the body. Past the bound, the response errs if it came.
    // Over TLS these are the decrypted bytes, to which no session ticket adds: past 8 tickets, the
    // same error.
    request.on("socket", (socket) => {
      const refuse = () =>
        (answered ?? request).destroy(new AppError(egressErrors.egress_too_large));
      socket.on("data", () => {
        if (pastWire(socket, settings.maxBytes)) refuse();
      });
      let tickets = 0;
      socket.on("session", () => {
        tickets += 1;
        if (tickets > MAX_TICKETS) refuse();
      });
    });
    request.end();
  });
  // The deadline settles the hop, whatever the request does.
  return untilAborted(response, signal);
}

/**
 * The addresses this hop may connect to: the host itself when it is a literal, else the resolver's
 * answer, asked once. Any blocked address refuses the hop, unless allowsBlockedAddress opens it: an
 * allow-listed host that is itself loopback or a blocked literal, a local test server.
 */
async function checkedAddresses(
  url: URL,
  settings: Settings,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const host = canonicalHost(url.hostname);
  const addresses = isIP(host) !== 0 ? [host] : await resolveOnce(host, settings.resolve, signal);
  if (!allowsBlockedAddress(url, settings.lists) && addresses.some(isBlockedAddress)) {
    throw new AppError(egressErrors.egress_blocked_address);
  }
  return addresses;
}

async function resolveOnce(
  host: string,
  resolve: Resolver,
  signal: AbortSignal,
): Promise<readonly string[]> {
  let addresses: readonly string[];
  try {
    addresses = await untilAborted(resolve(host, signal), signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new AppError(egressErrors.egress_dns_failed, reasonOf(error));
  }
  if (addresses.length === 0) throw new AppError(egressErrors.egress_dns_failed);
  return addresses;
}

/**
 * The socket's lookup: the checked addresses, whatever name it is asked for, in the `all` form that
 * Node's family selection asks for and the single form otherwise. Node refuses an answer that is not
 * an IP address, so nothing else can be connected to.
 */
function pinnedTo(addresses: readonly string[]): LookupFunction {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  return (_host, options, callback) => {
    if (options.all) callback(null, entries);
    else callback(null, entries[0]?.address ?? "", entries[0]?.family);
  };
}

/** A redirect's Location, resolved against the URL that answered; checked like the first URL. */
function redirectTarget(location: string, current: URL): URL {
  const target = URL.parse(location, current);
  if (target === null) throw new AppError(egressErrors.egress_invalid_url);
  return target;
}

/**
 * The body, copied into one buffer that grows to maxBytes at most: no chunk is kept, so a body in
 * one-byte chunks costs what a body in large ones does. Past maxBytes it is egress_too_large, by
 * the Content-Length before reading or at the chunk that crosses it, unless `truncate` keeps the
 * first maxBytes bytes and closes the connection. Past 2 × maxBytes + 64 KiB read off the socket,
 * get() errs the response with egress_too_large either way.
 */
async function readBody(
  response: IncomingMessage,
  { maxBytes, truncate }: Settings,
): Promise<{ body: Buffer; truncated: boolean }> {
  const declared = Number(response.headers["content-length"]);
  if (declared > maxBytes && !truncate) throw tooLarge(response);
  // A Content-Length sizes the first buffer to 64 KiB at most: a server may claim much, send none.
  let body = Buffer.alloc(Math.min(maxBytes, declared || 0, 65_536));
  let size = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    const room = maxBytes - size;
    if (chunk.length > room && !truncate) throw tooLarge(response);
    const piece = chunk.subarray(0, room);
    if (size + piece.length > body.length) {
      const grown = Buffer.alloc(
        Math.min(maxBytes, Math.max(size + piece.length, 2 * body.length)),
      );
      body.copy(grown, 0, 0, size);
      body = grown;
    }
    size += piece.copy(body, size);
    if (chunk.length > room) {
      response.destroy();
      return { body: body.subarray(0, size), truncated: true };
    }
  }
  return { body: body.subarray(0, size), truncated: false };
}

/** Past 2 × maxBytes + 64 KiB read off the socket, every byte counted. */
function pastWire(socket: Socket, maxBytes: number): boolean {
  return socket.bytesRead > 2 * maxBytes + WIRE_SLACK;
}

/** egress_too_large, the connection closed first: nothing more is read. */
function tooLarge(response: IncomingMessage): AppError {
  response.destroy();
  return new AppError(egressErrors.egress_too_large);
}

/** The promise, or the deadline: a resolver that never answers cannot outlast the call. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** A refusal as it is; a failed connection, TLS check or response as one code with Node's code. */
function failure(error: unknown): AppError {
  if (isAppError(error)) return error;
  return new AppError(egressErrors.egress_request_failed, reasonOf(error));
}

/** Node's short error code (`ECONNREFUSED`, `ERR_TLS_CERT_ALTNAME_INVALID`), never a message. */
function reasonOf(error: unknown): { details?: { reason: string } } {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && NODE_CODE.test(code) ? { details: { reason: code } } : {};
}
