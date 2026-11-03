import http from "node:http";
import module, { createRequire } from "node:module";

export { request } from "node:https";
export * from "node:net";
export const viaKey = (url: string) => http["get"](url);
export const viaCast = (url: string) => (http as typeof http).get(url);
export default http;
const load = createRequire(import.meta.url);
const https = load("node:https");
export const viaLoad = (url: string) => https.get(url);
export const dgram = process.getBuiltinModule("node:dgram");
const req = module.createRequire(import.meta.url);
export const viaModule = (url: string) => req("node:http").get(url);
