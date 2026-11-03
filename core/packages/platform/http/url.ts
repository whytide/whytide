// checkUrl (alpha-p1-060): the URL rules of docs/rules/security.md §5, run before a request and on
// every redirect hop by the client of alpha-p1-065. A host name the parser keeps but nothing should
// resolve, the scheme and credentials first, then the deny-list; an allow-listed host (a local test
// server) then passes the last two rules: no loopback by name or by a literal address in any
// notation, and no port but the scheme's own. Each refusal is one code of egressErrors and carries
// no details: the URL could name a person, and the code says it all. allowsBlockedAddress is the
// client's decision on the addresses an allow-listed host resolves to.
import { isIP } from "node:net";
import { AppError } from "../errors/index.ts";
import { isBlockedAddress } from "./address.ts";
import { egressConfig } from "./config.ts";
import { egressErrors } from "./errors.ts";
import { canonicalHost, type HostEntry, hasEmptyLabel, matchesHostList } from "./hosts.ts";

export type EgressLists = {
  /** Hosts the address and port rules skip (local test servers); EGRESS_ALLOW_HOSTS by default. */
  readonly allowHosts?: readonly HostEntry[];
  /** Hosts never fetched; EGRESS_DENY_HOSTS by default. A host on both lists is denied. */
  readonly denyHosts?: readonly HostEntry[];
};

const SCHEMES = new Set(["http:", "https:"]);

/** The parsed URL when server code may fetch it; otherwise an AppError with the rule's code. */
export function checkUrl(input: string | URL, lists?: EgressLists | null): URL {
  const given = lists ?? {};
  const url = parse(input);
  const host = canonicalHost(url.hostname);
  if (hasEmptyLabel(host)) throw new AppError(egressErrors.egress_invalid_url);
  if (!SCHEMES.has(url.protocol)) throw new AppError(egressErrors.egress_bad_scheme);
  if (url.username !== "" || url.password !== "") {
    throw new AppError(egressErrors.egress_credentials_in_url);
  }
  if (matchesHostList(url, given.denyHosts ?? egressConfig.EGRESS_DENY_HOSTS)) {
    throw new AppError(egressErrors.egress_denied_host);
  }
  if (isAllowListed(url, given)) return url;
  if (isBlockedHost(host)) throw new AppError(egressErrors.egress_blocked_address);
  if (url.port !== "") throw new AppError(egressErrors.egress_port_not_allowed);
  return url;
}

/** Whether the URL's host, with its port, is on the allow-list (EGRESS_ALLOW_HOSTS by default). */
export function isAllowListed(url: URL, lists?: EgressLists | null): boolean {
  return matchesHostList(url, lists?.allowHosts ?? egressConfig.EGRESS_ALLOW_HOSTS);
}

/**
 * Whether the client may connect to a blocked address for this URL: only when the host is on the
 * allow-list and is itself loopback by name or a literal address the rules refuse (`localhost`,
 * `127.0.0.1:3000`, `[::1]:3000`: a local test server). An allow entry on any other host opens a
 * port, not an address: the client still refuses every blocked address such a host resolves to.
 */
export function allowsBlockedAddress(url: URL, lists?: EgressLists | null): boolean {
  return isAllowListed(url, lists) && isBlockedHost(canonicalHost(url.hostname));
}

function parse(input: string | URL): URL {
  if (input instanceof URL) return input;
  try {
    return new URL(input);
  } catch {
    throw new AppError(egressErrors.egress_invalid_url);
  }
}

/** Loopback by name, `localhost` and every name under it (RFC 6761 §6.3), or a blocked literal. */
function isBlockedHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isIP(host) !== 0 && isBlockedAddress(host);
}
