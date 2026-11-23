// The browser port (docs/architecture.md §9, docs/rules/coding.md §6; the owner's decision of
// 2026-11-13): a page rendered in a headless browser, for a company website that shows nothing until
// its scripts run, in our words (README.md). One method, renderPage(). The input is one URL, any
// scheme, so that an adapter refuses a file: or ftp: one as browser_blocked; the output is the page's
// final URL, its status, its visible text and its links, bounded, strict and checked in every
// environment, production included: no HTML, no screenshot, no cookie. browser_unavailable is an
// answer for the caller, who keeps the plain fetch's page (gamma-en-065).
import { z } from "zod";
import { definePort } from "../_pattern/index.ts";
import {
  LINK_PROTOCOL,
  LINK_TEXT_MAX,
  LINKS_MAX,
  PAGE_PROTOCOL,
  STATUS_MAX,
  STATUS_MIN,
  TEXT_MAX,
  URL_MAX,
} from "./constants.ts";

export { browserConfig } from "./config.ts";
export type { BrowserFake } from "./fake/index.ts";

/** The page asked for: one URL, nothing else. */
export const pageRequest = z.strictObject({ url: z.url().max(URL_MAX) });

/** A link of the page: absolute, http, https or mailto, with its text, spaces collapsed. */
export const pageLink = z.strictObject({
  href: z.url({ protocol: LINK_PROTOCOL }).max(URL_MAX),
  text: z.string().max(LINK_TEXT_MAX),
});

/** The page as it rendered: where it ended, its status, its visible text and its links. */
export const renderedPage = z.strictObject({
  finalUrl: z.url({ protocol: PAGE_PROTOCOL }).max(URL_MAX),
  status: z.int().min(STATUS_MIN).max(STATUS_MAX),
  text: z.string().max(TEXT_MAX),
  links: z.array(pageLink).max(LINKS_MAX),
});

export type PageRequest = z.infer<typeof pageRequest>;
export type PageLink = z.infer<typeof pageLink>;
export type RenderedPage = z.infer<typeof renderedPage>;

export const browserPort = definePort({
  name: "browser",
  errorPrefix: "browser",
  alwaysCheckOutputs: true,
  methods: {
    renderPage: { input: pageRequest, output: renderedPage },
  },
  errors: {
    /**
     * Refused by the egress rules, the page or a redirect it followed: a scheme but http and https,
     * a port but the scheme's own, a host on EGRESS_DENY_HOSTS or one that resolves to a blocked
     * address. `details.reason`, the rule's code; nothing was sent there.
     */
    browser_blocked: { status: 403 },
    /** The page took longer than its limit. */
    browser_timeout: { status: 504 },
    /** The page's document was larger than its limit. */
    browser_too_large: { status: 413 },
    /** The browser service did not answer: the caller keeps the page it has. */
    browser_unavailable: { status: 503 },
    /** Anything else: `details.reason`, a short code, never a message. */
    browser_provider_error: { status: 502 },
  },
});
