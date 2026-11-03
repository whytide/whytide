import { request } from "node:http";
export const client = (url: string) => [fetch(url), request(url)];
