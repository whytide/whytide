// The browser port's contract (README.md "The contract suite"): what every adapter does, run by each
// adapter's tests in its world, the fake's seeded pages or a local test site behind the playwright
// adapter. The world's page renders to its final URL, status, text and links in the port's words; a
// scheme but http and https, an address the platform blocks and a port but the scheme's own are
// browser_blocked with no request sent; an input off the port's shape is refused before any call.
import assert from "node:assert/strict";
import { isAppError } from "@whytide/platform";
import type { ContractCases } from "../testing/index.ts";
import { URL_MAX } from "./constants.ts";
import type { browserPort, PageRequest, RenderedPage } from "./port.ts";

/** A page of the world, and what the adapter answers for it. */
export type WorldPage = { readonly url: string; readonly page: RenderedPage };
export type BrowserWorld = {
  /** A page the adapter renders; runs inside its case, after a fake's reset. */
  readonly page: () => WorldPage | Promise<WorldPage>;
  /** The requests sent for pages so far; never the adapter's own connection to its service. */
  readonly requests: () => number;
};

/** Each one browser_blocked: a scheme but http and https, a blocked address, a port off the scheme's. */
export const BLOCKED_URLS: readonly string[] = [
  "file:///etc/passwd",
  "ftp://ftp.example.test/pub/notes.txt",
  "javascript:alert(1)",
  "http://10.0.0.1/",
  "http://127.0.0.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]/",
  "https://example.test:8443/",
];
type Inputs = readonly (readonly [label: string, input: unknown])[];
const OFF_SHAPE: Inputs = [
  ["no URL", {}],
  ["a URL without a scheme", { url: "example.test/about" }],
  ["a URL as a number", { url: 42 }],
  ["a URL past 2,048 characters", { url: `https://example.test/${"a".repeat(URL_MAX)}` }],
  ["a second field", { url: "https://example.test/", waitMs: 30_000 }],
];

/** The error is the port's `code`. */
const failsWith = (code: string) => (error: unknown) => {
  assert.ok(isAppError(error) && error.code === code, `${code}, not ${String(error)}`);
  return true;
};

export function browserCases(world: BrowserWorld): ContractCases<typeof browserPort> {
  return {
    "renders the world's page: its final URL, status, visible text and links, in the port's words":
      async (port) => {
        const { url, page } = await world.page();
        assert.deepEqual(await port.renderPage({ url }), page);
      },
    "a scheme but http and https, a blocked address and a port off the scheme's are browser_blocked, and no request is sent":
      async (port) => {
        const before = world.requests();
        for (const url of BLOCKED_URLS) {
          await assert.rejects(port.renderPage({ url }), failsWith("browser_blocked"), url);
        }
        assert.equal(world.requests(), before, "no request was sent");
      },
    "refuses an input off the port's shape before any call: browser_input_invalid": async (
      port,
    ) => {
      const before = world.requests();
      for (const [label, input] of OFF_SHAPE) {
        const render = port.renderPage(input as PageRequest);
        await assert.rejects(render, failsWith("browser_input_invalid"), label);
      }
      assert.equal(world.requests(), before, "no request was sent");
    },
  };
}
