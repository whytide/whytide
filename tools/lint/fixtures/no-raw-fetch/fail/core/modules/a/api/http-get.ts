import http from "node:http";
export const get = (url: string) => http.get(url);
