// The browser fake (../README.md "The fake"): pages seeded in memory under their URL as the URL parser
// writes it, so that `https://Example.test` and `https://example.test/` are one page. renderPage
// answers a copy of the page seeded under the URL, its final URL that URL and its status 200 unless
// the seed gives them; any other URL is browser_blocked, as an address the fake may not reach. The
// fake fetches nothing and counts the pages it rendered (`state.rendered`). create() refuses
// APP_ENV=production: the fake never stands in for the browser on a server.
import { AppError, platformConfig } from "@whytide/platform";
import { createFake, defineAdapter, patternErrors } from "../../_pattern/index.ts";
import { browserPort, type PageLink } from "../port.ts";
import { NOT_SEEDED, SEEDED_PROTOCOLS, SEEDED_STATUS } from "./constants.ts";

const { errors } = browserPort;

/** A page as a test seeds it: its text and links; where it ends and its status, when not the URL and 200. */
export type SeededPage = {
  readonly text: string;
  readonly links: readonly PageLink[];
  readonly finalUrl?: string;
  readonly status?: number;
};

/** The URL as the parser writes it, when it is http or https. */
function pageKey(url: string): string | undefined {
  const parsed = URL.parse(url);
  return parsed && SEEDED_PROTOCOLS.has(parsed.protocol) ? parsed.href : undefined;
}

export const browserFake = createFake(browserPort, {
  state: () => ({ pages: new Map<string, SeededPage>(), rendered: 0 }),
  methods: (fake) => ({
    renderPage: async ({ url }) => {
      const key = pageKey(url);
      const page = key === undefined ? undefined : fake.state.pages.get(key);
      if (key === undefined || page === undefined) {
        throw new AppError(errors.browser_blocked, { details: { reason: NOT_SEEDED } });
      }
      fake.state.rendered += 1;
      const { text, links, finalUrl = key, status = SEEDED_STATUS } = structuredClone(page);
      return { finalUrl, status, text, links: [...links] };
    },
  }),
  helpers: (fake) => ({
    /** The page renderPage answers for `url`, an http or https URL, until the next reset. */
    seedPage: (url: string, page: SeededPage): void => {
      const key = pageKey(url);
      if (key === undefined) throw new TypeError("seedPage takes an http or https URL");
      fake.state.pages.set(key, structuredClone(page));
    },
  }),
});

export type BrowserFake = typeof browserFake;

export const browserFakeAdapter = defineAdapter(browserPort, {
  name: "fake",
  create: () => {
    if (platformConfig.APP_ENV === "production") {
      const details = { port: browserPort.name, adapter: "fake", reason: "APP_ENV=production" };
      throw new AppError(patternErrors.adapter_invalid, { details });
    }
    return browserFake;
  },
});
