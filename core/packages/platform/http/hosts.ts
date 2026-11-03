// The host lists of the egress rules (alpha-p1-060): EGRESS_ALLOW_HOSTS and EGRESS_DENY_HOSTS hold
// comma-separated `host` or `host:port` entries, an IPv6 literal bare or in brackets
// (`[::1]:3000`). An entry names one exact host, never its subdomains and never a wildcard; one
// with a port matches that port only, one without matches the host on any port. A host is compared
// the way the URL parser writes it, through the parser itself: lowercase, punycode, canonical IPv4,
// no brackets and no trailing dot, so `Example.com.` or `0x7f.0.0.1` cannot slip past a list.
import { isIP } from "node:net";
import { AppError } from "../errors/index.ts";
import { egressErrors } from "./errors.ts";

export type HostEntry = { readonly host: string; readonly port?: number };

const DEFAULT_PORTS: Readonly<Record<string, number>> = { "http:": 80, "https:": 443 };
const PORT = /^\d{1,5}$/;

/** The entries of one list, frozen; a malformed one (a bad port, a path, a wildcard) is refused. */
export function parseHostList(text: string): readonly HostEntry[] {
  const entries = text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => {
      const entry = parseHostEntry(item);
      if (!entry) throw new AppError(egressErrors.egress_invalid_host_entry);
      return Object.freeze(entry);
    });
  return Object.freeze(entries);
}

/** Whether the URL's host, on the entry's port when it names one, is on the list. */
export function matchesHostList(url: URL, list: readonly HostEntry[]): boolean {
  const host = canonicalHost(url.hostname);
  const port = effectivePort(url);
  return list.some(
    (entry) => entry.host === host && (entry.port === undefined || entry.port === port),
  );
}

/** A URL's host name as the lists write it: no brackets around an IPv6 literal, no trailing dot. */
export function canonicalHost(hostname: string): string {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return bare.endsWith(".") ? bare.slice(0, -1) : bare;
}

/**
 * Whether a canonical host name has an empty label (`localhost.`, from `localhost..`;
 * `.example.com`; `a..b`): the URL parser keeps such a name, no list would match it and no resolver
 * should.
 */
export function hasEmptyLabel(host: string): boolean {
  if (host === "" || host.includes(":")) return false;
  return host.split(".").some((label) => label === "");
}

/** The port a URL connects to: the explicit one, else the scheme's own; none for another scheme. */
function effectivePort(url: URL): number | undefined {
  return url.port === "" ? DEFAULT_PORTS[url.protocol] : Number(url.port);
}

function parseHostEntry(item: string): HostEntry | undefined {
  if (item.includes("*")) return undefined;
  let host = item;
  let portText: string | undefined;
  if (item.startsWith("[")) {
    const end = item.indexOf("]");
    if (end === -1) return undefined;
    host = item.slice(1, end);
    const rest = item.slice(end + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) return undefined;
      portText = rest.slice(1);
    }
    if (isIP(host) !== 6) return undefined;
  } else if (isIP(item) !== 6) {
    const parts = item.split(":");
    if (parts.length > 2) return undefined;
    [host = "", portText] = parts;
  }
  const canonical = hostAsParsed(host);
  if (canonical === undefined || hasEmptyLabel(canonical)) return undefined;
  if (portText === undefined) return { host: canonical };
  const port = PORT.test(portText) ? Number(portText) : 0;
  return port >= 1 && port <= 65535 ? { host: canonical, port } : undefined;
}

/** The host as the URL parser writes it; undefined when the text is more or less than a host. */
function hostAsParsed(text: string): string | undefined {
  const authority = isIP(text) === 6 ? `[${text}]` : text;
  let url: URL;
  try {
    url = new URL(`http://${authority}/`);
  } catch {
    return undefined;
  }
  const onlyAHost =
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  return onlyAHost ? canonicalHost(url.hostname) : undefined;
}
