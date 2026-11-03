// The website fetch's page rules without a network (alpha-p4-020; README "The website fetch"): the
// text a page keeps, the links it gives and which of them the fetch reads, in which order, past
// robots.txt. The fetch itself is the worker's test, core/apps/worker/tests/onboarding-fetch.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { parseHtml } from "../domain/pages/html.ts";
import { selectPages } from "../domain/pages/links.ts";
import { isAllowed, parseRobots } from "../domain/pages/robots.ts";

test("text extraction keeps the title, headings and paragraphs; drops scripts, styles, navigation, footers and comments", () => {
  const page = parseHtml(`<!doctype html><html><head><title>Acme &amp; Co</title>
    <style>.hero { color: red }</style><script>var tracking = "<p>not text</p>";</script></head>
    <body><header><nav><a href="/blog">Blog</a></nav><a href="/">Acme</a></header>
    <main><h1>Robots for <em>warehouses</em></h1><!-- <p>hidden</p> -->
    <p>Acme builds picking robots&#8203;.<br>Since 2019 &mdash; 120 sites.</p><div>Night shifts<p>Weekends</div>
    <svg><title>Icon</title><text>svg text</text></svg><noscript>Enable JavaScript</noscript></main>
    <footer><a href="/about">About us</a> Copyright Acme</footer></body></html>`);
  assert.equal(page.title, "Acme & Co");
  assert.deepEqual(page.text.split("\n"), [
    "Acme",
    "# Robots for warehouses",
    "Acme builds picking robots​.",
    "Since 2019 — 120 sites.",
    "Night shifts",
    "Weekends",
  ]);
  assert.deepEqual(page.links, [
    { href: "/blog", nav: true },
    { href: "/", nav: true },
    { href: "/about", nav: false },
  ]);
});

test("link selection: same host only, each page once, home, about, product, pricing, customers, then navigation, then the rest", () => {
  const home = new URL("https://www.acme.test/");
  const links = [
    { href: "/blog", nav: true },
    { href: "/careers/", nav: true },
    { href: "/customers", nav: true },
    { href: "https://acme.test/pricing#plans", nav: true },
    { href: "https://other.test/about", nav: false },
    { href: "/product", nav: false },
    { href: "/brochure.pdf", nav: false },
    { href: "mailto:hello@acme.test", nav: false },
    { href: "/", nav: false },
    { href: "/careers", nav: false },
    { href: "/en/about-us", nav: false },
    { href: "/contact", nav: false },
  ];
  const all = () => true;
  const paths = (urls: URL[]) => urls.map((url) => `${url.hostname}${url.pathname}`);
  assert.deepEqual(paths(selectPages(home, links, 4, all)), [
    "www.acme.test/en/about-us",
    "www.acme.test/product",
    "acme.test/pricing",
    "www.acme.test/customers",
  ]);
  assert.deepEqual(paths(selectPages(home, links, 7, all)).slice(4), [
    "www.acme.test/blog",
    "www.acme.test/careers/",
    "www.acme.test/contact",
  ]);
  const robots = parseRobots(
    "User-agent: other\nDisallow: /\n\nUser-agent: *\nDisallow: /pricing\nDisallow: /*.php$\nAllow: /pricing/plans\n",
  );
  const allowed = (url: URL) => isAllowed(robots, url);
  assert.deepEqual(paths(selectPages(home, links, 4, allowed)), [
    "www.acme.test/en/about-us",
    "www.acme.test/product",
    "www.acme.test/customers",
    "www.acme.test/blog",
  ]);
  assert.equal(isAllowed(robots, new URL("https://acme.test/pricing/plans")), true);
  assert.equal(isAllowed(robots, new URL("https://acme.test/index.php")), false);
  assert.equal(isAllowed(robots, new URL("https://acme.test/index.php?x=1")), true);
});
