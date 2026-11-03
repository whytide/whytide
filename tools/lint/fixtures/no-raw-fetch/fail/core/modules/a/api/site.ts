import http from "node:http";
import { request } from "node:https";
import axios from "axios";
export const site = (url: string) => [axios.get(url), http.request(url), request(url)];
export const page = (url: string) => globalThis.fetch(url);
