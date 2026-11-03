import { Agent } from "node:_http_agent";
import dns from "node:dns/promises";
import { ClientRequest } from "_http_client";
import { connect } from "_tls_wrap";
import { lookup } from "dns";
export const resolve = (domain: string) => [
  dns.resolveMx(domain),
  lookup,
  ClientRequest,
  Agent,
  connect,
];
