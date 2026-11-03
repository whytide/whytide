// fromOwnPage (../confirm.ts), the confirm step's check of a link's POST: Sec-Fetch-Site decides when
// the browser sends it, same-origin only; without it, an Origin among the origins or on the Host.
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { fromOwnPage } from "../confirm.ts";

const post = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

test("fromOwnPage: same-origin by Sec-Fetch-Site or by an Origin on the Host; same-site, cross-site and Origin null fail", () => {
  const app = { origin: "http://app.test", host: "app.test" };
  assert.equal(fromOwnPage(post({ ...app, "sec-fetch-site": "same-origin" })), true);
  for (const site of ["same-site", "cross-site", "none"]) {
    assert.equal(fromOwnPage(post({ ...app, "sec-fetch-site": site })), false, site);
  }
  assert.equal(fromOwnPage(post(app)), true);
  assert.equal(fromOwnPage(post({ origin: "http://app.test" }), ["http://app.test"]), true);
  assert.equal(fromOwnPage(post({ origin: "null" })), false);
  assert.equal(fromOwnPage(post({ origin: "http://evil.test", host: "app.test" })), false);
});
