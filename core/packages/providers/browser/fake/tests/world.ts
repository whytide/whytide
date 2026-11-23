// The fake as the contract's world (../../contract.ts): a synthetic page seeded inside each case,
// after the suite's reset, under one URL and ending at another; the pages the fake rendered stand for
// the requests sent, so that a refused URL shows as none.
import type { BrowserWorld, WorldPage } from "../../contract.ts";
import type { RenderedPage } from "../../port.ts";
import type { BrowserFake } from "../index.ts";

export const PAGE_URL = "https://copper-harbor.example/about";
/** Every field the port has, synthetic. */
export const PAGE: RenderedPage = {
  finalUrl: "https://www.copper-harbor.example/about",
  status: 200,
  text: "Copper Harbor Labs\nSynthetic harbours for the contract suite.",
  links: [
    { href: "https://www.linkedin.com/company/copper-harbor-labs", text: "LinkedIn" },
    { href: "mailto:hello@copper-harbor.example", text: "Write to us" },
  ],
};

export const fakeWorld = (fake: BrowserFake): BrowserWorld => ({
  page: (): WorldPage => {
    fake.seedPage(PAGE_URL, PAGE);
    return { url: PAGE_URL, page: PAGE };
  },
  requests: () => fake.state.rendered,
});
