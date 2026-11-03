// fetchSafe's default resolver (alpha-p1-065) against a DNS stub on 127.0.0.1: once A has answered,
// a silent AAAA gets 50 ms (RFC 8305); a lost A query is sent again before the deadline. A new
// Resolver asks the system's servers, so each one is pointed at the stub when it is first asked.
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { Resolver } from "node:dns/promises";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

const asked = new Map<string, number>(); // "<first label>/<query type>": the queries received
const stub = dgram.createSocket("udp4");
stub.on("message", (query, peer) => {
  let end = 12;
  while (query[end] !== 0) end += (query[end] ?? 0) + 1;
  const type = query.readUInt16BE(end + 1);
  const label = String(query.subarray(13, 13 + (query[12] ?? 0)));
  const count = (asked.get(`${label}/${type}`) ?? 0) + 1;
  asked.set(`${label}/${type}`, count);
  // silent: AAAA is never answered; lossy: the first A query is lost. A is 127.0.0.1, AAAA no data.
  if (type === 28 ? label === "silent" : label === "lossy" && count === 1) return;
  const head = Buffer.from(query.subarray(0, 12));
  head.writeUInt16BE(0x8180, 2); // a response, no error
  head.writeUInt16BE(type === 1 ? 1 : 0, 6);
  head.writeUInt32BE(0, 8); // no authority or additional records
  const record = Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 127, 0, 0, 1]);
  const parts = [head, query.subarray(12, end + 5), ...(type === 1 ? [record] : [])];
  stub.send(Buffer.concat(parts), peer.port, peer.address);
});
await new Promise<void>((resolve) => stub.bind(0, "127.0.0.1", resolve));
const server = `127.0.0.1:${(stub.address() as AddressInfo).port}`;
type Resolve = (this: Resolver, host: string) => Promise<string[]>;
const { fetchSafe } = await import("../http/index.ts");
test.after(() => stub.close());

test("AAAA gets 50 ms once A answers; a lost query is resent", { timeout: 10_000 }, async (t) => {
  // Patched in the test and put back when it ends: a test file sharing the process gets Node's own.
  const { resolve4, resolve6 } = Resolver.prototype;
  t.after(() => Object.assign(Resolver.prototype, { resolve4, resolve6 }));
  for (const method of ["resolve4", "resolve6"] as const) {
    const original = { resolve4, resolve6 }[method] as Resolve;
    Object.assign(Resolver.prototype, {
      [method](this: Resolver, host: string) {
        // Once: Node refuses setServers while a query is pending, and AAAA follows A at once.
        if (this.getServers().join() !== server) this.setServers([server]);
        return original.call(this, host);
      },
    });
  }
  // 127.0.0.1 is refused: egress_blocked_address says that the answer came before the deadline.
  const started = performance.now();
  const silent = fetchSafe("http://silent.test/", { maxRedirects: 0, timeoutMs: 4000 });
  await assert.rejects(silent, { code: "egress_blocked_address" });
  assert.ok(performance.now() - started < 1000); // a try of AAAA alone takes 1000 ms at least
  const lossy = fetchSafe("http://lossy.test/", { maxRedirects: 0, timeoutMs: 2000 });
  await assert.rejects(lossy, { code: "egress_blocked_address" });
  assert.deepEqual([asked.get("silent/28"), asked.get("lossy/1")], [1, 2]);
});
