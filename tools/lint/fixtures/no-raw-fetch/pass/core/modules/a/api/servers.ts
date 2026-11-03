import type { IncomingMessage } from "node:http";
import { createServer, type RequestOptions } from "node:https";
import * as net from "node:net";
import tls from "node:tls";
import { egress } from "@whytide/platform";

const { createSecureServer } = await import("node:http2");
const http = require("node:http");
export const servers = [createServer(), net.createServer(), new net.Server(), tls.createServer()];
export const more = [createSecureServer(), http.createServer()];
export const handle = (request: IncomingMessage, options: RequestOptions, socket: net.Socket) => [
  request,
  options,
  socket,
];
export type Fetch = typeof fetch;
export const options = { fetch: "egress" };
export class Client {
  fetch(url: string) {
    return egress.fetch(url);
  }
}
