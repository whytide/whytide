// The address classifier of the egress rules (alpha-p1-060, docs/rules/security.md §5): the ranges
// server code never connects to, in IPv4, IPv6 and IPv4-mapped IPv6 form. Node's BlockList compares
// bits, never text, so the dotted, hexadecimal and expanded spellings of one mapped address, and an
// IPv6 zone, are the same blocked address. The client of alpha-p1-065 asks for every address a host
// resolves to.
import { BlockList, isIP } from "node:net";

type Range = readonly [address: string, prefix: number, family: "ipv4" | "ipv6"];

/**
 * Private, loopback, link-local (the metadata service lives there), this network, carrier-grade
 * NAT, the IETF protocol assignments, Azure's wireserver, benchmarking and the reserved 240/4 with
 * the broadcast address; IPv6 unique-local, link-local, site-local and benchmarking; `::/96`,
 * which holds the unspecified address `::` (a connect to it reaches loopback), `::1` and the
 * deprecated IPv4-compatible `::a.b.c.d`; and the IPv6 ranges that embed an IPv4 address,
 * IPv4-translated, NAT64, 6to4 and Teredo, through which `64:ff9b::127.0.0.1` would reach a blocked
 * IPv4 address. Multicast stays out: TCP cannot connect to it.
 */
const RANGES: readonly Range[] = [
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["0.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["192.0.0.0", 24, "ipv4"], // IETF assignments, RFC 6890; .192: Oracle Cloud Classic's metadata
  ["168.63.129.16", 32, "ipv4"], // Azure's wireserver, reachable from every Azure VM
  ["198.18.0.0", 15, "ipv4"], // benchmarking, RFC 2544
  ["240.0.0.0", 4, "ipv4"], // reserved, RFC 1112 §4, with the limited broadcast 255.255.255.255
  ["::", 96, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["fec0::", 10, "ipv6"],
  ["::ffff:0:0:0", 96, "ipv6"], // IPv4-translated, ::ffff:0:a.b.c.d, RFC 2765
  ["64:ff9b::", 96, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["2001::", 32, "ipv6"],
  ["2001:2::", 48, "ipv6"], // benchmarking, RFC 5180, the twin of 198.18/15
];

const blocked = new BlockList();
for (const [address, prefix, family] of RANGES) blocked.addSubnet(address, prefix, family);

/**
 * True for an address in a listed range, in any form; also true for anything that is not an IP
 * address, so a caller that passes a name or garbage fails closed. Brackets around an IPv6 literal,
 * as a URL writes it, are allowed.
 */
export function isBlockedAddress(address: string): boolean {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const family = isIP(bare);
  if (family === 0) return true;
  return blocked.check(bare, family === 4 ? "ipv4" : "ipv6");
}
