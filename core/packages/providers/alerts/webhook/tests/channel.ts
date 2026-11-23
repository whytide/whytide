// A team channel on 127.0.0.1 for the webhook adapter's tests (../README.md "Tests"): an HTTP server
// that records every request and plays the answer a test queued, 200 "ok" otherwise. An answer can
// be held: no answer at all, or a body of some bytes, or an endless one, left open until the adapter
// closes it, which `closed()` waits for. It imports Node's modules only, so a test can load it before
// it sets the egress lists the platform reads when imported. Nothing here reaches past 127.0.0.1.
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Answer = {
  /** 200 unless given. */
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Written whole, then the answer ends. */
  readonly body?: string;
  /** No answer at all: the request is held until the adapter gives up. */
  readonly silent?: boolean;
  /** After the head, this many bytes of body, then the answer is held open; Infinity writes on. */
  readonly openAfter?: number;
};

export type Received = {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | undefined;
  readonly body: string;
};

const LOCAL = "127.0.0.1";
const FILL = Buffer.alloc(16_384, "x");

/** The channel, at `path` on a free port of 127.0.0.1. */
export async function startChannel(path: string) {
  const requests: Received[] = [];
  const answers: Answer[] = [];
  const held = new Set<ServerResponse>();
  const closings: Promise<unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    requests.push({
      method: request.method ?? "",
      path: request.url ?? "",
      contentType: request.headers["content-type"],
      body: Buffer.concat(chunks).toString("utf8"),
    });
    const answer = answers.shift() ?? { body: "ok" };
    response.on("error", () => undefined);
    if (answer.silent || answer.openAfter !== undefined) {
      held.add(response);
      closings.push(once(response, "close"));
    }
    if (answer.silent) return;
    response.writeHead(answer.status ?? 200, answer.headers);
    if (answer.openAfter === undefined) return void response.end(answer.body);
    if (Number.isFinite(answer.openAfter))
      return void response.write(Buffer.alloc(answer.openAfter, "x"));
    // Endless: as much as the adapter reads, until it closes the connection.
    const pump = () => {
      while (!response.destroyed && response.write(FILL)) {}
    };
    response.on("drain", pump);
    pump();
  });
  server.listen(0, LOCAL);
  await once(server, "listening");
  const origin = `http://${LOCAL}:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    url: `${origin}${path}`,
    requests,
    answerNext: (answer: Answer) => void answers.push(answer),
    /** Resolves once every answer held so far is closed: by the adapter, as the tests expect. */
    closed: () => Promise.all(closings),
    close: async () => {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

export type Channel = Awaited<ReturnType<typeof startChannel>>;

/** A URL at `path` on a port of 127.0.0.1 nothing listens on: a refused connection. */
export async function closedUrl(path: string): Promise<string> {
  const server = createServer().listen(0, LOCAL);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return `http://${LOCAL}:${port}${path}`;
}
