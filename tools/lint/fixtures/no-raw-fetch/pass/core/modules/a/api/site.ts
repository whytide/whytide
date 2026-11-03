import http from "node:http";
import { egress } from "@whytide/platform";
export const site = (url: string) => egress.fetch(url);
export const server = http.createServer();
