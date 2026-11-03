// The unit tests of alpha-p2-030 (docs/security.md): the sliding window's arithmetic, the request
// hash of an Idempotency-Key and the client a limit counts, all pure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, requestHash } from "../src/protection/idempotency.ts";
import { clientNetwork, slidingWindow, WINDOW_MS } from "../src/protection/rate-limit.ts";

test("slidingWindow: the limit within a minute, the previous minute by the share still inside it", () => {
  const at = (elapsedMs: number, previous: number, current: number) =>
    slidingWindow({ limit: 600, windowMs: WINDOW_MS, elapsedMs, previous, current });
  assert.deepEqual(at(1_000, 0, 599), { allowed: true });
  // The 601st waits for the next minute, until 599 of the 600 count: 100 ms into it.
  assert.deepEqual(at(1_000, 0, 600), { allowed: false, retryAfterMs: 59_100 });
  // A second into a minute, 590 of the previous 600 count: ten more fit.
  assert.deepEqual(at(1_000, 600, 9), { allowed: true });
  assert.deepEqual(at(1_000, 600, 10), { allowed: false, retryAfterMs: 100 });
  // Half way, half of them: 300 more fit, the next one 100 ms later.
  assert.deepEqual(at(30_000, 600, 299), { allowed: true });
  assert.deepEqual(at(30_000, 600, 300), { allowed: false, retryAfterMs: 100 });
});

test("requestHash: one request hashes the same in any key order; method, path, query and body count", () => {
  const request = {
    method: "post",
    url: "/v1/workspaces/w/x?a=1",
    body: { b: [1, { d: 2, c: 3 }], a: null },
  };
  const hash = requestHash(request);
  assert.match(hash, /^[0-9a-f]{64}$/);
  const reordered = { a: null, b: [1, { c: 3, d: 2 }] };
  assert.equal(requestHash({ ...request, method: "POST", body: reordered }), hash);
  for (const other of [
    { method: "PUT" },
    { url: "/v1/workspaces/w/y?a=1" },
    { url: "/v1/workspaces/w/x?a=2" },
    { body: { a: null, b: [{ c: 3, d: 2 }, 1] } },
    { body: undefined },
  ]) {
    assert.notEqual(requestHash({ ...request, ...other }), hash, JSON.stringify(other));
  }
  assert.equal(
    canonicalJson({ b: 1, a: { d: 1, c: [2, { f: 0, e: 1 }] } }),
    '{"a":{"c":[2,{"e":1,"f":0}],"d":1},"b":1}',
  );
});

test("clientNetwork: an IPv4 address as it is, an IPv6 address by its /64 in any spelling", () => {
  assert.equal(clientNetwork("203.0.113.7"), "203.0.113.7");
  assert.equal(clientNetwork("::ffff:203.0.113.7"), "203.0.113.7");
  for (const address of [
    "2001:db8:a:b::1",
    "2001:0DB8:000a:000b:ffff:1:2:3",
    "2001:db8:a:b:0:0:0:9%eth0",
    "2001:db8:a:b::5.6.7.8",
  ]) {
    assert.equal(clientNetwork(address), "2001:db8:a:b::/64", address);
  }
  assert.equal(clientNetwork("2001:db8:a:c::1"), "2001:db8:a:c::/64");
  assert.equal(clientNetwork("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientNetwork("::1"), "0:0:0:0::/64");
  assert.equal(clientNetwork("1:2:3:4:5:6:7:8::9"), "1:2:3:4::/64", "more than eight groups");
});
