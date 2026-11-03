// The post_engagers kind's rules (alpha-p8-010; README.md "Kinds"): the post URL validator, the short
// link's form and its resolver, the config schema that calls it, and the schedule. No test reaches
// the network: the resolver takes its request as a parameter, and the schema's is mocked.
import assert from "node:assert/strict";
import test from "node:test";
import { AppError, type FetchSafeResponse, isAppError } from "@whytide/platform";
import { schedule } from "../sources/post_engagers/index.ts";
import {
  canonicalPostUrl,
  type Get,
  resolveShortLink,
  shortLinks,
  shortLinkUrl,
} from "../sources/post_engagers/post-url.ts";
import { parseSourceConfig, sourceKind } from "../sources/registry.ts";

const POST =
  "https://www.linkedin.com/posts/example-author_launch-day-activity-7250000000000000000-AbCd";
const FEED = "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000";
const ENCODED = "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A7250000000000000000";
const SHARED = POST.replace("-activity-", "-share-");
const SHORT = "https://lnkd.in/p/gNJ7DVDG";
/** Where lnkd.in sends a short link: the post's link with the share's query, the sharer's rcm in it. */
const LOCATION = `${SHARED}?highlightedUpdateUrn=urn%3Ali%3Ashare%3A7250000000000000000&utm_source=share&utm_medium=member_desktop&rcm=ACoAAB`;

/** fetchSafe's answer to a short link: the status, and the Location when given. */
const answer = (status: number, location?: string): FetchSafeResponse => ({
  status,
  headers: location === undefined ? {} : { location },
  body: Buffer.alloc(0),
  truncated: false,
  finalUrl: SHORT,
  hops: 0,
});
/** A request that answers `response`, or throws it, and records each call in `calls`. */
const answering =
  (response: FetchSafeResponse | Error, calls: Parameters<Get>[] = []): Get =>
  async (...request) => {
    calls.push(request);
    if (response instanceof Error) throw response;
    return response;
  };

test("the post URL validator: LinkedIn post URLs, as https://www.linkedin.com<path>; nothing else", () => {
  const accepted: Record<string, string> = {
    [POST]: POST,
    [`${POST.replace("www.", "")}/?utm_source=share&rcm=ACoAAB`]: `${POST}/`,
    [POST.replace("-activity-", "-share-")]: POST.replace("-activity-", "-share-"),
    [POST.replace("-activity-", "-ugcPost-")]: POST.replace("-activity-", "-ugcPost-"),
    [`${FEED}/`]: `${FEED}/`,
    [`${FEED.replace("activity", "share")}#comments`]: FEED.replace("activity", "share"),
    [FEED.replace("activity", "ugcPost")]: FEED.replace("activity", "ugcPost"),
    [ENCODED]: ENCODED,
  };
  for (const [url, canonical] of Object.entries(accepted)) {
    assert.equal(canonicalPostUrl(url), canonical, url);
  }
  const refused = [
    "https://www.linkedin.com/in/example-author/",
    "https://www.linkedin.com/company/example-company/posts/",
    POST.replace("https:", "http:"),
    POST.replace("www.", "uk."),
    POST.replace("www.linkedin.com", "linkedin.com.example.com"),
    POST.replace("https://", "https://user:secret@"),
    POST.replace("linkedin.com", "linkedin.com:8443"),
    `${POST}/comments`,
    FEED.replace("7250000000000000000", "abc"),
    FEED.replace("activity", "comment"),
    "not a URL",
  ];
  for (const url of refused) assert.equal(canonicalPostUrl(url), null, url);
});

test("a short link: https://lnkd.in/p/<code> or https://lnkd.in/<code>, without the query or the fragment; nothing else", () => {
  const code = "a".repeat(64);
  const accepted: Record<string, string> = {
    [SHORT]: SHORT,
    "https://lnkd.in/gNJ7DVDG": "https://lnkd.in/gNJ7DVDG",
    "https://LNKD.IN/p/a_b-C9?trk=share#top": "https://lnkd.in/p/a_b-C9",
    [`https://lnkd.in/${code}`]: `https://lnkd.in/${code}`,
  };
  for (const [url, link] of Object.entries(accepted)) assert.equal(shortLinkUrl(url), link, url);
  const refused = [
    SHORT.replace("https:", "http:"),
    SHORT.replace("lnkd.in", "www.lnkd.in"),
    SHORT.replace("lnkd.in", "lnkd.in.example.com"),
    SHORT.replace("https://", "https://user:secret@"),
    SHORT.replace("lnkd.in", "lnkd.in:8443"),
    "https://lnkd.in/",
    "https://lnkd.in/p/",
    `${SHORT}/more`,
    "https://lnkd.in/p/gNJ7%2FDVDG",
    `https://lnkd.in/${code}a`,
    POST,
  ];
  for (const url of refused) assert.equal(shortLinkUrl(url), null, url);
});

test("the resolver: one GET to the short link itself, unfollowed; a redirect to a post is its canonical URL without the query; any other answer null; a failed request signal_post_link_unreachable", async () => {
  const calls: Parameters<Get>[] = [];
  assert.equal(await resolveShortLink(SHORT, answering(answer(301, LOCATION), calls)), SHARED);
  const request = {
    maxRedirects: 0,
    returnRedirect: true,
    maxBytes: 1024,
    truncate: true,
    timeoutMs: 5000,
  };
  assert.deepEqual(calls, [[SHORT, request]]);
  const others = [
    answer(200),
    answer(301),
    answer(302, "https://www.linkedin.com/in/example-author/"),
    answer(301, "/p/gNJ7DVDG"),
  ];
  for (const other of others) assert.equal(await resolveShortLink(SHORT, answering(other)), null);
  const timeout = new AppError("egress_timeout");
  await assert.rejects(resolveShortLink(SHORT, answering(timeout)), (error: unknown) => {
    assert.ok(isAppError(error));
    const { code, status, details, cause } = error;
    assert.deepEqual(
      [code, status, details, cause],
      ["signal_post_link_unreachable", 502, undefined, timeout],
    );
    return true;
  });
  const bug = new Error("not the egress client's");
  await assert.rejects(resolveShortLink(SHORT, answering(bug)), (error) => error === bug);
});

test("the config: a short link is stored as its post's canonical URL, a 200 or another page is signal_config_invalid naming config.postUrl, a failed request signal_post_link_unreachable; the six full-link forms make no request", async (t) => {
  let response: FetchSafeResponse | Error = answer(301, LOCATION);
  const get = t.mock.method(shortLinks, "get", async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const parse = (postUrl: string) => parseSourceConfig(sourceKind("post_engagers"), { postUrl });
  const ugc = POST.replace("-activity-", "-ugcPost-");
  const feeds = ["activity", "share", "ugcPost"].map((kind) => FEED.replace("activity", kind));
  for (const url of [POST, SHARED, ugc, ...feeds])
    assert.deepEqual(await parse(url), { postUrl: url });
  assert.equal(get.mock.callCount(), 0);
  for (const link of [SHORT, "https://lnkd.in/gNJ7DVDG"]) {
    assert.deepEqual(await parse(link), { postUrl: SHARED });
  }
  const links = get.mock.calls.map((call) => call.arguments[0]);
  assert.deepEqual(links, [SHORT, "https://lnkd.in/gNJ7DVDG"]);
  for (const other of [answer(200), answer(301, "https://www.linkedin.com/feed/")]) {
    response = other;
    const fields = ["config.postUrl"];
    await assert.rejects(parse(SHORT), { code: "signal_config_invalid", details: { fields } });
  }
  response = new AppError("egress_dns_failed");
  await assert.rejects(parse(SHORT), { code: "signal_post_link_unreachable", status: 502 });
});

test("the schedule: at save, then three and seven days later", () => {
  const savedAt = new Date("2026-10-22T09:30:00.000Z");
  assert.deepEqual(
    schedule({ postUrl: POST }, savedAt).map((at) => at.toISOString()),
    ["2026-10-22T09:30:00.000Z", "2026-10-25T09:30:00.000Z", "2026-10-29T09:30:00.000Z"],
  );
});
