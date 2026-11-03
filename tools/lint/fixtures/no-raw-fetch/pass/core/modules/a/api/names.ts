import { fetch as safeFetch } from "./egress.ts";

export type { IncomingMessage } from "node:http";
export { fetch } from "./egress.ts";
export const first = (urls: string[]) => {
  fetch: for (const url of urls) {
    if (url) break fetch;
  }
  return safeFetch(urls[0] ?? "");
};
