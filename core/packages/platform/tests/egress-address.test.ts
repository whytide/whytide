// Unit tests of the egress rules (alpha-p1-060): the address classifier over every listed range in
// IPv4, IPv6 and IPv4-mapped form, and checkUrl's refusals, each with its code, the host lists and
// the allow-list. No network and no environment: the lists are passed in, and the two variables are
// cleared before the import so that the defaults are what the config falls back to.
import assert from "node:assert/strict";
import { test } from "node:test";
import { httpStatus, isAppError, registeredErrors } from "../errors/index.ts";
import { throwsCode } from "../testing/index.ts";

delete process.env.EGRESS_ALLOW_HOSTS;
delete process.env.EGRESS_DENY_HOSTS;
const {
  allowsBlockedAddress,
  checkUrl,
  egressConfig,
  egressErrors,
  isAllowListed,
  isBlockedAddress,
  matchesHostList,
  parseHostList,
  readEgressConfig,
} = await import("../http/index.ts");

const none = { allowHosts: [], denyHosts: [] };
const blockedV4: Record<string, string[]> = {
  "10/8": ["10.0.0.0", "10.0.0.1", "10.255.255.255"],
  "172.16/12": ["172.16.0.0", "172.16.0.1", "172.31.255.255"],
  "192.168/16": ["192.168.0.0", "192.168.1.1", "192.168.255.255"],
  "127/8": ["127.0.0.0", "127.0.0.1", "127.255.255.255"],
  "169.254/16": ["169.254.0.0", "169.254.169.254", "169.254.255.255"],
  "0/8": ["0.0.0.0", "0.1.2.3", "0.255.255.255"],
  "100.64/10": ["100.64.0.0", "100.64.0.1", "100.127.255.255"],
  "192.0.0/24 (IETF assignments, .9 and .10 too)": [
    "192.0.0.0",
    "192.0.0.9",
    "192.0.0.10",
    "192.0.0.192",
    "192.0.0.255",
  ],
  "168.63.129.16 (Azure's wireserver)": ["168.63.129.16"],
  "198.18/15 (benchmarking)": ["198.18.0.0", "198.18.0.1", "198.19.255.255"],
  "240/4 (reserved, with the broadcast address)": ["240.0.0.0", "240.0.0.1", "255.255.255.255"],
};
const blockedV6: Record<string, string[]> = {
  "::1": ["::1", "0:0:0:0:0:0:0:1", "[::1]"],
  "::/96 (the unspecified address, IPv4-compatible)": [
    "::",
    "::0",
    "0:0:0:0:0:0:0:0",
    "[::]",
    "::2",
    "::127.0.0.1",
    "::7f00:1",
    "[::127.0.0.1]",
    "::ffff:ffff",
  ],
  "fc00::/7": ["fc00::", "fc00::1", "fd12:3456:789a::1", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  "fe80::/10": [
    "fe80::",
    "fe80::1",
    "fe80::dead:beef",
    "febf:ffff::1",
    "fe80::1%eth0",
    "[fe80::1]",
  ],
  "fec0::/10 (site-local)": ["fec0::", "fec0::1", "feff:ffff::1"],
  "::ffff:0:0:0/96 (IPv4-translated)": [
    "::ffff:0:0:0",
    "::ffff:0:127.0.0.1",
    "0:0:0:0:ffff:0:a9fe:a9fe",
    "::ffff:0:ffff:ffff",
    "[::ffff:0:8.8.8.8]",
  ],
  "64:ff9b::/96 (NAT64)": [
    "64:ff9b::",
    "64:ff9b::127.0.0.1",
    "64:ff9b::7f00:1",
    "[64:ff9b::127.0.0.1]",
  ],
  "64:ff9b:1::/48 (NAT64)": ["64:ff9b:1::", "64:ff9b:1::1", "64:ff9b:1:ffff::1"],
  "2002::/16 (6to4)": ["2002::", "2002:7f00:1::", "2002:ffff:ffff::1"],
  "2001::/32 (Teredo)": ["2001::", "2001::1", "2001:0:7f00:1::", "2001:0:ffff::1"],
  "2001:2::/48 (benchmarking)": ["2001:2::", "2001:2::1", "2001:2:0:ffff:ffff:ffff:ffff:ffff"],
};
const publicV4 = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "203.0.113.5"];
const publicV6 = ["2001:db8::1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"];
const nextToTheRanges = [
  "9.255.255.255",
  "11.0.0.0",
  "172.15.255.255",
  "172.32.0.0",
  "192.167.255.255",
  "192.169.0.0",
  "126.255.255.255",
  "128.0.0.0",
  "169.253.255.255",
  "169.255.0.0",
  "1.0.0.0",
  "100.63.255.255",
  "100.128.0.0",
  "191.255.255.255",
  "192.0.1.0",
  "168.63.129.15",
  "168.63.129.17",
  "198.17.255.255",
  "198.20.0.0",
  "239.255.255.255", // multicast, which stays unblocked
  "::1:0:0",
  "::fffe:ffff:ffff:ffff",
  "::ffff:1:0:0",
  "fbff:ffff::1",
  "fe00::1",
  "fe7f:ffff::1",
  "64:ff9a:ffff::1",
  "64:ff9b:2::1",
  "2000:ffff::1",
  "2001:1::1",
  "2001:1:ffff:ffff:ffff:ffff:ffff:ffff",
  "2001:2:1::",
  "2001:ffff::1",
  "2003::1",
];

/** The four spellings of an IPv4-mapped IPv6 address: dotted, expanded, hexadecimal, upper case. */
function mappedForms(v4: string): string[] {
  const [a, b, c, d] = v4.split(".").map(Number) as [number, number, number, number];
  const hex = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  return [`::ffff:${v4}`, `0:0:0:0:0:ffff:${v4}`, `::ffff:${hex}`, `::FFFF:${v4}`];
}

test("isBlockedAddress: each listed range in IPv4, IPv6 and IPv4-mapped IPv6 form", () => {
  for (const [range, addresses] of Object.entries(blockedV4)) {
    for (const address of addresses) {
      assert.equal(isBlockedAddress(address), true, `${address} is in ${range}`);
      for (const mapped of mappedForms(address)) {
        assert.equal(isBlockedAddress(mapped), true, `${mapped} maps into ${range}`);
      }
    }
  }
  for (const [range, addresses] of Object.entries(blockedV6)) {
    for (const address of addresses) {
      assert.equal(isBlockedAddress(address), true, `${address} is in ${range}`);
    }
  }
});

test("isBlockedAddress: public addresses and the addresses next to the ranges pass", () => {
  for (const address of [...publicV4, ...publicV6, ...nextToTheRanges]) {
    assert.equal(isBlockedAddress(address), false, `${address} is public`);
  }
  for (const address of publicV4) {
    for (const mapped of mappedForms(address)) {
      assert.equal(isBlockedAddress(mapped), false, `${mapped} maps to a public address`);
    }
  }
});

test("isBlockedAddress fails closed: what is not an IP address counts as blocked", () => {
  for (const notAnAddress of ["example.com", "", "10.0.0", "127.1", " 10.0.0.1", "0x7f.0.0.1"]) {
    assert.equal(isBlockedAddress(notAnAddress), true, JSON.stringify(notAnAddress));
  }
});

test("checkUrl refuses each URL of the acceptance criteria with its code", () => {
  const blocked = egressErrors.egress_blocked_address;
  const invalid = egressErrors.egress_invalid_url;
  const refused: [string, string][] = [
    ["http://127.0.0.1/", blocked],
    ["http://169.254.169.254/latest/meta-data", blocked],
    ["http://[::1]/", blocked],
    ["http://10.0.0.1/", blocked],
    ["http://10.0.0.1:8080/", blocked],
    ["http://localhost/", blocked],
    ["http://LOCALHOST./", blocked],
    ["http://api.localhost:3000/", blocked],
    ["http://0x7f.0.0.1/", blocked],
    ["http://2130706433/", blocked],
    ["http://0177.0.0.1/", blocked],
    ["http://127.1/", blocked],
    ["http://0/", blocked],
    ["http://[::ffff:7f00:1]/", blocked],
    ["http://[0:0:0:0:0:ffff:10.0.0.1]/", blocked],
    ["http://[fe80::1]/", blocked],
    ["http://[fd00::1]/", blocked],
    ["http://[::]/", blocked],
    ["http://[::0]/", blocked],
    ["http://[0:0:0:0:0:0:0:0]/", blocked],
    ["http://[::127.0.0.1]/", blocked],
    ["http://[64:ff9b::127.0.0.1]/", blocked],
    ["http://[2002:7f00:1::]/", blocked],
    ["http://[2001:0:7f00:1::]/", blocked],
    ["http://[fec0::1]/", blocked],
    ["http://168.63.129.16/machine?comp=goalstate", blocked],
    ["http://198.18.0.1/", blocked],
    ["http://240.0.0.1/", blocked],
    ["http://255.255.255.255/", blocked],
    ["http://[::ffff:0:169.254.169.254]/", blocked],
    ["http://192.0.0.192/", blocked],
    ["http://[2001:2::1]/", blocked],
    // What the parser canonicalizes before the rules see it: pinned, so a parser change is noticed.
    ["http://127.0.0.%31/", blocked],
    ["http://loc%61lhost/", blocked],
    ["http://localhost%2e/", blocked],
    ["http://ⓛⓞⓒⓐⓛⓗⓞⓢⓣ/", blocked],
    ["http://127。0。0。1/", blocked],
    ["http://0251.0376.0251.0376/", blocked],
    ["http://0xa9fea9fe/", blocked],
    ["http://[fe80::1%25eth0]/", invalid],
    // A host name with an empty label: the parser keeps it, no list matches it.
    ["http://localhost../", invalid],
    ["http://127.0.0.1../", invalid],
    ["http://.example.com/", invalid],
    ["http://example..com/", invalid],
    ["ftp://example.com/", egressErrors.egress_bad_scheme],
    ["file:///etc/passwd", egressErrors.egress_bad_scheme],
    ["gopher://example.com/", egressErrors.egress_bad_scheme],
    ["javascript:alert(1)", egressErrors.egress_bad_scheme],
    ["data:text/plain,hi", egressErrors.egress_bad_scheme],
    ["ws://example.com/", egressErrors.egress_bad_scheme],
    ["http://user:pass@example.com/", egressErrors.egress_credentials_in_url],
    ["http://user@example.com/", egressErrors.egress_credentials_in_url],
    ["https://:pass@example.com/", egressErrors.egress_credentials_in_url],
    ["http://example.com:8443/", egressErrors.egress_port_not_allowed],
    ["https://example.com:8080/", egressErrors.egress_port_not_allowed],
    ["http://example.com:443/", egressErrors.egress_port_not_allowed],
    ["https://example.com:80/", egressErrors.egress_port_not_allowed],
    ["http://example.com:0/", egressErrors.egress_port_not_allowed],
    ["not a url", invalid],
    ["", invalid],
    ["http://", invalid],
    ["http://exa mple.com/", invalid],
    ["example.com/path", invalid],
    ["http://example.com:65536/", invalid],
  ];
  for (const [url, code] of refused) {
    assert.throws(
      () => checkUrl(url, none),
      (error: unknown) => isAppError(error) && error.code === code && error.status === 400,
      `${url} is refused with ${code}`,
    );
  }
  // The same rules on a URL object, and with no lists at all.
  throwsCode(() => checkUrl(new URL("http://127.0.0.1/"), none), "egress_blocked_address");
  throwsCode(() => checkUrl("http://127.0.0.1/", null), "egress_blocked_address");
});

test("checkUrl refuses a host on the deny-list, as the parser writes the host, before the allow-list", () => {
  const deny = parseHostList("denied.example, bücher.example, byport.example:443");
  throwsCode(() => checkUrl("https://denied.example/", { denyHosts: deny }), "egress_denied_host");
  throwsCode(
    () => checkUrl("https://DENIED.example./x", { denyHosts: deny }),
    "egress_denied_host",
  );
  throwsCode(
    () => checkUrl("http://xn--bcher-kva.example/", { denyHosts: deny }),
    "egress_denied_host",
  );
  throwsCode(() => checkUrl("https://byport.example/", { denyHosts: deny }), "egress_denied_host");
  assert.equal(
    checkUrl("http://byport.example/", { denyHosts: deny }).href,
    "http://byport.example/",
  );
  // Two trailing dots would slip past the list; the name is refused as invalid instead.
  throwsCode(
    () => checkUrl("https://denied.example../", { denyHosts: deny }),
    "egress_invalid_url",
  );
  const both = { allowHosts: parseHostList("localhost"), denyHosts: parseHostList("localhost") };
  throwsCode(() => checkUrl("http://localhost:3000/", both), "egress_denied_host");
});

test("checkUrl accepts a public URL, and an allow-listed host with its port", () => {
  const plain = checkUrl("https://example.com/", none);
  assert.ok(plain instanceof URL);
  assert.equal(plain.href, "https://example.com/");
  assert.equal(checkUrl("http://Example.COM/a?b=1#c", none).href, "http://example.com/a?b=1#c");
  assert.equal(checkUrl("https://example.com:443/", none).port, "");
  assert.equal(checkUrl("http://example.com:080/", none).port, "");
  assert.equal(checkUrl("http://example.com./", none).hostname, "example.com.");
  const given = new URL("https://example.com/");
  assert.equal(checkUrl(given, none), given);

  const allow = parseHostList("example.com:8443, localhost, 127.0.0.1:3000, [::1]:3000, ::2");
  assert.equal(checkUrl("http://example.com:8443/", { allowHosts: allow }).port, "8443");
  assert.equal(checkUrl("http://localhost:3000/", { allowHosts: allow }).host, "localhost:3000");
  assert.equal(checkUrl("http://localhost/", { allowHosts: allow }).host, "localhost");
  assert.equal(checkUrl("http://127.0.0.1:3000/", { allowHosts: allow }).host, "127.0.0.1:3000");
  assert.equal(checkUrl("http://[::1]:3000/", { allowHosts: allow }).host, "[::1]:3000");
  assert.equal(checkUrl("http://[::2]:4000/", { allowHosts: allow }).host, "[::2]:4000");
  // An entry with a port allows that port only; the other rules stay.
  throwsCode(
    () => checkUrl("http://example.com:9000/", { allowHosts: allow }),
    "egress_port_not_allowed",
  );
  throwsCode(
    () => checkUrl("http://other.example:8443/", { allowHosts: allow }),
    "egress_port_not_allowed",
  );
  throwsCode(() => checkUrl("http://127.0.0.1/", { allowHosts: allow }), "egress_blocked_address");
  throwsCode(() => checkUrl("http://[::1]:3001/", { allowHosts: allow }), "egress_blocked_address");
  throwsCode(
    () => checkUrl("http://user@localhost:3000/", { allowHosts: allow }),
    "egress_credentials_in_url",
  );
  throwsCode(() => checkUrl("ftp://localhost/", { allowHosts: allow }), "egress_bad_scheme");
  throwsCode(() => checkUrl("http://localhost../", { allowHosts: allow }), "egress_invalid_url");
});

test("the allow-list opens an address only for a host that is itself loopback or a blocked literal", () => {
  const lists = {
    allowHosts: parseHostList("localhost, 127.0.0.1:3000, [::1]:3000, example.com:8443"),
  };
  const url = (text: string) => new URL(text);
  assert.equal(isAllowListed(url("http://localhost:3000/"), lists), true);
  assert.equal(isAllowListed(url("http://example.com:8443/"), lists), true);
  assert.equal(isAllowListed(url("http://example.com/"), lists), false);
  assert.equal(isAllowListed(url("http://127.0.0.1/"), lists), false);
  // A local test server: the client connects to the blocked address the host is or resolves to.
  assert.equal(allowsBlockedAddress(url("http://localhost:3000/"), lists), true);
  assert.equal(allowsBlockedAddress(url("http://127.0.0.1:3000/"), lists), true);
  assert.equal(allowsBlockedAddress(url("http://[::1]:3000/"), lists), true);
  // A name on the allow-list opened a port, not an address: its resolved addresses are still checked.
  assert.equal(allowsBlockedAddress(url("http://example.com:8443/"), lists), false);
  assert.equal(allowsBlockedAddress(url("http://127.0.0.1/"), lists), false);
  assert.equal(allowsBlockedAddress(url("http://localhost:3000/"), none), false);
  assert.equal(allowsBlockedAddress(url("http://localhost:3000/"), null), false);
  assert.equal(isAllowListed(url("http://localhost:3000/")), false);
});

test("without lists checkUrl reads the config, whose two variables default to empty lists", () => {
  assert.deepEqual(egressConfig.EGRESS_ALLOW_HOSTS, []);
  assert.deepEqual(egressConfig.EGRESS_DENY_HOSTS, []);
  assert.ok(Object.isFrozen(egressConfig.EGRESS_ALLOW_HOSTS));
  assert.equal(checkUrl("https://example.com/").href, "https://example.com/");
  throwsCode(() => checkUrl("http://example.com:8443/"), "egress_port_not_allowed");
  throwsCode(() => checkUrl("http://localhost:3000/"), "egress_blocked_address");
});

test("the host lists: host or host:port entries, canonical hosts, a malformed entry refused", () => {
  const parsed = parseHostList(
    "Example.com, localhost:3000 ,[::1]:8080, ::1, 10.0.0.1:80, 127.1, bücher.example,,",
  );
  assert.deepEqual(parsed, [
    { host: "example.com" },
    { host: "localhost", port: 3000 },
    { host: "::1", port: 8080 },
    { host: "::1" },
    { host: "10.0.0.1", port: 80 },
    { host: "127.0.0.1" },
    { host: "xn--bcher-kva.example" },
  ]);
  assert.ok(Object.isFrozen(parsed) && parsed.every((entry) => Object.isFrozen(entry)));
  assert.deepEqual(parseHostList(""), []);
  assert.deepEqual(parseHostList(" , "), []);
  const malformed = [
    "example.com:abc",
    "example.com:0",
    "example.com:65536",
    "example.com:",
    ":80",
    "[::1",
    "[::1]x",
    "[::1]:x",
    "[example.com]",
    "a:b:c",
    "exa mple.com",
    "example.com/path",
    "user@example.com",
    "example.com?x",
    "example.com#x",
    "http://example.com",
    "*.example.com",
    "*",
    "example.*:443",
    "example..com",
    ".example.com",
    "example.com..",
  ];
  for (const entry of malformed) {
    throwsCode(() => parseHostList(entry), "egress_invalid_host_entry");
  }
  const url = (text: string) => new URL(text);
  assert.equal(matchesHostList(url("http://localhost:3000/"), parseHostList("localhost")), true);
  assert.equal(
    matchesHostList(url("http://localhost:3000/"), parseHostList("localhost:3000")),
    true,
  );
  assert.equal(
    matchesHostList(url("http://localhost:3000/"), parseHostList("localhost:3001")),
    false,
  );
  assert.equal(
    matchesHostList(url("https://example.com/"), parseHostList("example.com:443")),
    true,
  );
  assert.equal(
    matchesHostList(url("http://example.com/"), parseHostList("example.com:443")),
    false,
  );
  assert.equal(matchesHostList(url("http://example.com./"), parseHostList("example.com")), true);
  assert.equal(matchesHostList(url("http://[::1]:3000/"), parseHostList("[::1]:3000")), true);
  assert.equal(matchesHostList(url("http://[::1]:3000/"), parseHostList("::1")), true);
  assert.equal(
    matchesHostList(url("http://sub.example.com/"), parseHostList("example.com")),
    false,
  );
  assert.equal(matchesHostList(url("https://example.com/"), []), false);
});

test("the config block: both variables parsed, a malformed entry names the variable, never the value", () => {
  const empty = readEgressConfig({});
  assert.deepEqual(empty.EGRESS_ALLOW_HOSTS, []);
  assert.deepEqual(empty.EGRESS_DENY_HOSTS, []);
  const some = readEgressConfig({
    EGRESS_ALLOW_HOSTS: "localhost:3000, [::1]:3000",
    EGRESS_DENY_HOSTS: "",
  });
  assert.deepEqual(some.EGRESS_ALLOW_HOSTS, [
    { host: "localhost", port: 3000 },
    { host: "::1", port: 3000 },
  ]);
  assert.deepEqual(some.EGRESS_DENY_HOSTS, []);
  assert.ok(
    Object.isFrozen(some.EGRESS_ALLOW_HOSTS) && Object.isFrozen(some.EGRESS_ALLOW_HOSTS[0]),
  );
  assert.deepEqual(Object.keys(some), ["EGRESS_ALLOW_HOSTS", "EGRESS_DENY_HOSTS"]);
  assert.throws(
    () => readEgressConfig({ EGRESS_DENY_HOSTS: "secret-host.example:notaport" }),
    (error: unknown) => {
      assert.ok(isAppError(error) && error.code === "config_invalid");
      assert.equal(error.details?.block, "packages/platform");
      assert.deepEqual(error.details?.variables, [
        "EGRESS_DENY_HOSTS: host or host:port entries separated by commas",
      ]);
      assert.doesNotMatch(JSON.stringify(error.details), /secret-host|notaport/);
      return true;
    },
  );
});

test("the codes are registered: the refusals answer 400, a malformed list entry is the server's fault", () => {
  const refusals = [
    "egress_invalid_url",
    "egress_bad_scheme",
    "egress_credentials_in_url",
    "egress_denied_host",
    "egress_blocked_address",
    "egress_port_not_allowed",
  ];
  for (const code of refusals) {
    assert.ok(registeredErrors().has(code), code);
    assert.equal(httpStatus(code), 400, code);
  }
  assert.equal(httpStatus(egressErrors.egress_invalid_host_entry), 500);
});
