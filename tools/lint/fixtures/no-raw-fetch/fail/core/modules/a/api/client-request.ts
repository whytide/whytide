import * as http from "node:http";
export const send = (url: string) => new http.ClientRequest(url);
