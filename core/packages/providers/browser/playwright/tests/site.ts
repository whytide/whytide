// The playwright adapter's test site on 127.0.0.1 (../README.md "Tests"): pages and scripts by path,
// every request it receives recorded, a WebSocket's too; `/redirect?to=<url>` answers a 302 to any URL; `/held` never
// answers, until the site closes. Beside it, a target off the test hosts that records whatever
// reaches it, the egress recorder, every request Node's HTTP clients send from this process, and a
// resolver for the tests' host names. Node's modules only at run time, so that a test can load this
// file before it sets what the platform reads at import. Nothing here reaches past 127.0.0.1.
import { createSocket } from "node:dgram";
import { once } from "node:events";
import http, { createServer, type ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { mock } from "node:test";
import type { Resolver } from "@whytide/platform";

export type SitePage = {
  readonly body: string | Buffer;
  /** text/html unless given. */
  readonly type?: string;
  readonly status?: number;
};

const LOCAL = "127.0.0.1";
const HTML = "text/html; charset=utf-8";

/** The site on a free port of 127.0.0.1, serving `pages` by path. */
export async function startSite(pages: Readonly<Record<string, SitePage>>) {
  const received: string[] = [];
  const held = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    received.push(`${request.method} ${path}`);
    response.on("error", () => undefined);
    const { pathname, searchParams } = new URL(path, `http://${LOCAL}`);
    if (pathname === "/redirect") {
      response.writeHead(302, { location: searchParams.get("to") ?? "/" }).end();
      return;
    }
    if (pathname === "/held") {
      held.add(response);
      return;
    }
    const page = pages[pathname];
    if (page === undefined) {
      response.writeHead(404, { "content-type": HTML }).end("<p>Not found</p>");
      return;
    }
    response.writeHead(page.status ?? 200, { "content-type": page.type ?? HTML }).end(page.body);
  });
  // A WebSocket's opening request, recorded too, then refused.
  server.on("upgrade", (request, socket) => {
    received.push(`UPGRADE ${request.url ?? "/"}`);
    socket.destroy();
  });
  server.listen(0, LOCAL);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const origin = `http://${LOCAL}:${port}`;
  return {
    origin,
    port,
    /** The site's `host:port` entry, for the adapter's test hosts. */
    host: `${LOCAL}:${port}`,
    /** Every request the site received, `<method> <path>`, in order. */
    received,
    url: (path: string) => `${origin}${path}`,
    close: async () => {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

export type Site = Awaited<ReturnType<typeof startSite>>;

/**
 * A target on 127.0.0.1 that no test host names: every TCP connection, request and WebSocket opening
 * its HTTP port gets, and every datagram its UDP port gets (a STUN request, a QUIC packet), recorded
 * as it comes. Whatever reaches it went past the fences.
 */
export async function startTarget() {
  const reached: string[] = [];
  const server = createServer((request, response) => {
    reached.push(`${request.method} ${request.url ?? "/"}`);
    response.writeHead(200, { "content-type": HTML }).end("<p>Target</p>");
  });
  server.on("connection", () => reached.push("TCP"));
  server.on("upgrade", (request, socket) => {
    reached.push(`UPGRADE ${request.url ?? "/"}`);
    socket.destroy();
  });
  const udp = createSocket("udp4");
  udp.on("message", () => reached.push("UDP"));
  server.listen(0, LOCAL);
  udp.bind(0, LOCAL);
  await Promise.all([once(server, "listening"), once(udp, "listening")]);
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${LOCAL}:${port}`,
    udpPort: udp.address().port,
    /** What reached the target, in order: `TCP`, `<method> <path>`, `UPGRADE <path>` or `UDP`. */
    reached,
    close: async () => {
      server.closeAllConnections();
      server.close();
      udp.close();
      await once(server, "close");
    },
  };
}

/** A ws: URL on a port of 127.0.0.1 nothing listens on: a browser service that is down. */
export async function closedServiceUrl(): Promise<string> {
  const server = createServer().listen(0, LOCAL);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return `ws://${LOCAL}:${port}/`;
}

type Options = { hostname?: string | null; host?: string | null; port?: number | string | null };

/**
 * Every request Node's http and https clients send from now on, as `<host>:<port>`, the egress
 * client's and Playwright's connection to its service alike; `sent(service)` leaves out the
 * latter. Recorded, then sent as they would be.
 */
export function recordRequests() {
  const targets: string[] = [];
  for (const client of [http, https]) {
    const original = client.request;
    mock.method(client, "request", (...args: Parameters<typeof http.request>) => {
      const [first] = args;
      const target: Options =
        typeof first === "string" || first instanceof URL ? new URL(first) : (first as Options);
      targets.push(`${target.hostname ?? target.host}:${target.port ?? ""}`);
      return (original as (...given: Parameters<typeof http.request>) => http.ClientRequest)(
        ...args,
      );
    });
  }
  return {
    /** The requests sent so far, but those to the service at `serviceUrl`. */
    sent: (serviceUrl?: string): string[] => {
      const service = serviceUrl === undefined ? undefined : new URL(serviceUrl);
      return targets.filter(
        (target) => service === undefined || target !== `${service.hostname}:${service.port}`,
      );
    },
  };
}

/** The tests' host names: each answers its addresses, any other is not found. */
export function namesResolver(names: Readonly<Record<string, readonly string[]>>): Resolver {
  return async (host) => {
    const addresses = names[host];
    if (addresses !== undefined) return addresses;
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  };
}
