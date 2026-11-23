// The posts kinds (gamma-p5-020, gamma-p5-025; README.md "Kinds", "Runs", "Settings"):
// topic_engagement's, my_post_engagement's, competitor_engagement's and creator_engagement's configs,
// stored canonical, their readers and schedules, the creator's scrub; post engagers' end; each of the
// five lookback settings at most 30 days, as deploy/'s examples set them; a post's unnamed URL from
// either of the port's forms; a post's author and engagers as candidates, their evidence; an undated
// engager's date.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defineConfig, isAppError } from "@whytide/platform";
import { POST_PHRASE_MAX_CHARS } from "@whytide/providers";
import {
  type Candidate,
  isPostsReader,
  isResearchReader,
  readsThroughAccount,
} from "../sources/_contract.ts";
import {
  authorOf,
  engagersOf,
  type FiledPost,
  namesAuthor,
  postEvidenceOf,
  stagedAt,
  unnamedPostUrl,
} from "../sources/_posts.ts";
import { competitorLookback } from "../sources/competitor_engagement/config.ts";
import { creatorLookback } from "../sources/creator_engagement/config.ts";
import { myPostLookback } from "../sources/my_post_engagement/config.ts";
import { postEngagersLookback } from "../sources/post_engagers/config.ts";
import { fireTimes } from "../sources/post_engagers/index.ts";
import { parseSourceConfig, sourceKind } from "../sources/registry.ts";
import { topicLookback } from "../sources/topic_engagement/config.ts";
import { blockedTopic } from "../sources/topic_engagement/index.ts";
import { LANGUAGES, NEVER_FETCHED_HOSTS } from "../sources/web_research/constants.ts";
import { startPageOf } from "../sources/web_research/index.ts";

const ID = "7250000000000000000";
const NAMED = `https://www.linkedin.com/posts/jane-doe_launch-day-activity-${ID}-AbCd`;
const UNNAMED = `https://www.linkedin.com/feed/update/urn:li:activity:${ID}`;
const iso = (times: readonly Date[]) => times.map((at) => at.toISOString());
const topic = (config: unknown) => parseSourceConfig(sourceKind("topic_engagement"), config);
const invalid = (field: string) => ({
  code: "signal_config_invalid",
  details: { fields: [field] },
});

test("a topic's config: the phrase's words one space apart, the roles in their order, all three by default; 6 words, over 100 characters, no word, an unknown role, a role twice or none is signal_config_invalid naming it", async () => {
  const all = ["author", "commenter", "reactor"];
  const phrase = "revenue operations hiring";
  assert.deepEqual(await topic({ phrase: "  revenue\toperations   hiring " }), {
    phrase,
    roles: all,
  });
  const kept = await topic({ phrase: "RevOps", roles: ["reactor", "author"] });
  assert.deepEqual(kept, { phrase: "RevOps", roles: ["author", "reactor"] });
  assert.deepEqual(await topic(kept), kept);
  const long = "x".repeat(POST_PHRASE_MAX_CHARS + 1);
  for (const words of ["one two three four five six", long, "   ", 5]) {
    await assert.rejects(topic({ phrase: words }), invalid("config.phrase"));
  }
  for (const roles of [[], ["author", "author"], ["owner"], "author", [...all, "author"]]) {
    await assert.rejects(topic({ phrase, roles }), invalid("config.roles"));
  }
  await assert.rejects(topic({ phrase, label: "x" }), invalid("config"));
});

test("a topic on a special-category theme is signal_topic_blocked naming config.phrase, in any case or spacing, a plural too; a word that only holds a term is not", async () => {
  const themes = ["mental   HEALTH tips", "Elections", "trade union news", "LGBTQ founders"];
  for (const phrase of [...themes, "faith at work", "racial equity", "unionized teams"]) {
    await assert.rejects(topic({ phrase }), {
      code: "signal_topic_blocked",
      details: { fields: ["config.phrase"] },
    });
  }
  for (const phrase of ["healthcare SaaS", "family reunion", "racecar telemetry", "RevOps"]) {
    assert.equal(blockedTopic(phrase), false, phrase);
  }
});

test("own posts take an empty config; the posts kinds run at their save and end never, post engagers at the save, 3 and 7 days later within the lookback, and end with it", async () => {
  const own = sourceKind("my_post_engagement");
  assert.deepEqual(await parseSourceConfig(own, {}), {});
  await assert.rejects(parseSourceConfig(own, { postUrl: NAMED }), invalid("config"));
  const savedAt = new Date("2026-10-22T09:30:00.000Z");
  for (const kind of [own, sourceKind("topic_engagement")]) {
    assert.deepEqual(kind.schedule({}, savedAt), [savedAt]);
    assert.equal(kind.endsAt, undefined);
  }
  assert.deepEqual([own.lookbackDays, sourceKind("topic_engagement").lookbackDays], [30, 14]);
  const engagers = sourceKind("post_engagers");
  const ends = engagers.endsAt?.(savedAt);
  assert.equal(ends?.toISOString(), "2026-11-21T09:30:00.000Z");
  assert.ok(engagers.schedule({ postUrl: UNNAMED }, savedAt).every((at) => ends && at <= ends));
  assert.deepEqual(iso(fireTimes(savedAt, 5)), [
    "2026-10-22T09:30:00.000Z",
    "2026-10-25T09:30:00.000Z",
  ]);
  assert.deepEqual(iso(fireTimes(savedAt, 2)), ["2026-10-22T09:30:00.000Z"]);
});

const competitor = (config: unknown) =>
  parseSourceConfig(sourceKind("competitor_engagement"), config);
const creator = (config: unknown) => parseSourceConfig(sourceKind("creator_engagement"), config);
const naming = (...fields: string[]) => ({ code: "signal_config_invalid", details: { fields } });
const PAGE = "https://www.linkedin.com/company/acme-analytics";
const PROFILE = "https://www.linkedin.com/in/jane-doe";

test("a competitor's config: its page's link stored on https://www.linkedin.com without the query, the fragment or a trailing slash, its name's words one space apart; a link of another page, host or scheme, or a name off 2 to 100 characters is signal_config_invalid naming the field, both at once both", async () => {
  const link = " https://linkedin.com/company/acme-analytics/?trk=x#about ";
  const given = { companyUrl: link, companyName: "  Acme \t Analytics " };
  const stored = { companyUrl: PAGE, companyName: "Acme Analytics" };
  assert.deepEqual(await competitor(given), stored);
  assert.deepEqual(await competitor(stored), stored);
  for (const companyName of ["Ab", "x".repeat(100), "Zoë & Co."]) {
    assert.deepEqual(await competitor({ companyUrl: PAGE, companyName }), {
      companyUrl: PAGE,
      companyName,
    });
  }
  const others = [
    PROFILE,
    NAMED,
    `${PAGE}/posts/`,
    PAGE.replace("https:", "http:"),
    PAGE.replace("www.", "uk."),
    PAGE.replace("linkedin.com", "linkedin.com.example.org"),
    PAGE.replace("https://", "https://user@"),
    "acme-analytics",
  ];
  for (const companyUrl of others) {
    await assert.rejects(
      competitor({ companyUrl, companyName: "Acme" }),
      naming("config.companyUrl"),
    );
  }
  for (const companyName of ["A", "  A  ", "", "x".repeat(101), "Acme\u0000Inc", 5]) {
    await assert.rejects(
      competitor({ companyUrl: PAGE, companyName }),
      naming("config.companyName"),
    );
  }
  await assert.rejects(
    competitor({ companyUrl: PROFILE, companyName: "A" }),
    naming("config.companyUrl", "config.companyName"),
  );
  await assert.rejects(competitor({ ...stored, label: "x" }), naming("config"));
});

test("a creator's config: their profile's link stored on https://www.linkedin.com without the query or a trailing slash, its id percent-encoded; a company page, a post, another host or scheme is signal_config_invalid naming config.profileUrl", async () => {
  assert.deepEqual(await creator({ profileUrl: "https://linkedin.com/in/jane-doe/?trk=x" }), {
    profileUrl: PROFILE,
  });
  assert.deepEqual(await creator({ profileUrl: "https://www.linkedin.com/in/jürgen-m" }), {
    profileUrl: "https://www.linkedin.com/in/j%C3%BCrgen-m",
  });
  const others = [PAGE, NAMED, "https://www.linkedin.com/in/", PROFILE.replace("https:", "http:")];
  for (const profileUrl of [...others, "https://example.com/in/jane-doe", 7]) {
    await assert.rejects(creator({ profileUrl }), naming("config.profileUrl"));
  }
});

test("a competitor's page and a creator are posts kinds that read their author's posts, keep no author and every reaction, run at their save, never end and read back 14 days, each event of its own kind; the creator's scrub finds their profile however written, a competitor's page has none", () => {
  const savedAt = new Date("2026-10-22T09:30:00.000Z");
  const page = { companyUrl: PAGE, companyName: "Acme Analytics" };
  const profile = { profileUrl: "https://www.linkedin.com/in/Jane-Doe" };
  const kinds = [
    ["competitor_engagement", page, PAGE],
    ["creator_engagement", profile, profile.profileUrl],
  ] as const;
  for (const [name, config, authorUrl] of kinds) {
    const kind = sourceKind(name);
    const { reader } = kind;
    assert.ok(isPostsReader(reader), name);
    assert.deepEqual(reader.source(config), { by: "author", authorUrl });
    assert.equal(reader.keepsAuthors(config), false);
    assert.deepEqual([...reader.keepsReactions(config)], ["like", "comment", "repost"]);
    assert.deepEqual(kind.schedule(config, savedAt), [savedAt]);
    assert.deepEqual([kind.endsAt, kind.lookbackDays, kind.event.kind], [undefined, 14, name]);
  }
  const { scrub } = sourceKind("creator_engagement");
  assert.deepEqual(scrub?.(profile, "jane-doe"), { profileUrl: "" });
  const encoded = { profileUrl: "https://www.linkedin.com/in/J%C3%BCrgen-M" };
  assert.deepEqual(scrub?.(encoded, "jürgen-m"), { profileUrl: "" });
  for (const slug of ["jane", "jane-doe-smith", ""]) assert.equal(scrub?.(profile, slug), null);
  assert.equal(scrub?.({ profileUrl: "" }, "jane-doe"), null);
  assert.equal(sourceKind("competitor_engagement").scrub, undefined);
});

const settings = {
  SIGNALS_POST_ENGAGERS_LOOKBACK_DAYS: postEngagersLookback,
  SIGNALS_TOPIC_LOOKBACK_DAYS: topicLookback,
  SIGNALS_MY_POST_LOOKBACK_DAYS: myPostLookback,
  SIGNALS_COMPETITOR_LOOKBACK_DAYS: competitorLookback,
  SIGNALS_CREATOR_LOOKBACK_DAYS: creatorLookback,
};

test("each of the five lookback settings takes 30 days and refuses 31 with config_invalid, which stops the api and the worker at start", () => {
  for (const [name, schema] of Object.entries(settings)) {
    const read = (days: string) =>
      defineConfig("modules/signals", { [name]: schema }, { [name]: days });
    assert.deepEqual(read("30"), { [name]: 30 });
    assert.throws(
      () => read("31"),
      (error: unknown) => {
        assert.ok(isAppError(error));
        const { variables } = error.details as { variables: string[] };
        assert.deepEqual([error.code, variables.length], ["config_invalid", 1]);
        assert.ok(variables[0]?.startsWith(`${name}:`));
        return true;
      },
    );
  }
});

test("the five lookbacks deploy/.env.example and deploy/.env.production.example set pass their schemas", () => {
  const root = new URL("../../../../deploy/", import.meta.url);
  for (const file of [".env.example", ".env.production.example"]) {
    const lines = readFileSync(new URL(file, root), "utf8").split("\n");
    const set = lines.flatMap((line) => {
      const [, name, value] = /^(SIGNALS_\w+_LOOKBACK_DAYS)=(.*)$/.exec(line) ?? [];
      return name === undefined ? [] : [[name, value]];
    });
    assert.deepEqual(set.map(([name]) => name).sort(), Object.keys(settings).sort(), file);
    defineConfig("modules/signals", settings, Object.fromEntries(set));
  }
});

test("a post's unnamed URL, from either of the port's forms and for each kind of post; none for any other URL; the erasure's match on a /posts/ URL's author", () => {
  for (const kind of ["activity", "share", "ugcPost"]) {
    const unnamed = UNNAMED.replace("activity", kind);
    assert.equal(unnamedPostUrl(NAMED.replace("-activity-", `-${kind}-`)), unnamed);
    assert.equal(unnamedPostUrl(unnamed), unnamed);
    const encoded = `https://www.linkedin.com/feed/update/urn%3Ali%3A${kind}%3A${ID}/`;
    assert.equal(unnamedPostUrl(encoded), unnamed);
  }
  for (const other of ["https://www.linkedin.com/in/jane-doe", "https://www.linkedin.com/feed/"]) {
    assert.equal(unnamedPostUrl(other), null);
  }
  assert.ok(namesAuthor(NAMED, "jane-doe"));
  assert.ok(namesAuthor(NAMED.replace("jane-doe", "Jane-Doe"), "jane-doe"));
  const encoded = `https://www.linkedin.com/posts/j%C3%BCrgen-m_launch-activity-${ID}-AbCd`;
  assert.ok(namesAuthor(encoded, "jürgen-m"));
  for (const slug of ["jane", "jane-do", ""]) assert.equal(namesAuthor(NAMED, slug), false);
  assert.equal(namesAuthor(UNNAMED, "jane-doe"), false);
});

const author = {
  kind: "member" as const,
  providerMemberRef: "ACoAAAuthor",
  profileUrl: "https://www.linkedin.com/in/jane-doe",
  name: "Jane Doe",
  headline: "Founder",
};
const post: FiledPost = {
  postUrl: NAMED,
  postedAt: "2026-10-20T08:00:00.000Z",
  excerpt: "We shipped",
  author,
};
const engager = (reaction: string, engagedAt: string, more: Record<string, unknown> = {}) => ({
  providerMemberRef: `ACoAA-${reaction}`,
  profileUrl: `https://www.linkedin.com/in/sam-${reaction}`,
  name: "Sam Reader",
  headline: "VP Sales",
  reaction,
  engagedAt,
  ...more,
});

test("a post's author, a member, is a candidate `author` whose post is their own words; a page of engagers keeps the reactions asked for, from the cut on, each with the post's excerpt", () => {
  const candidate = authorOf(post, UNNAMED);
  assert.deepEqual(candidate, {
    providerMemberRef: "ACoAAAuthor",
    profileUrl: author.profileUrl,
    name: "Jane Doe",
    headline: "Founder",
    reaction: "author",
    commentText: "We shipped",
    engagedAt: new Date(post.postedAt),
    dateKnown: true,
    objectUrl: UNNAMED,
  });
  assert.deepEqual(candidate && postEvidenceOf(candidate), {
    url: UNNAMED,
    reaction: "author",
    ownWords: "We shipped",
    author: "Jane Doe",
  });
  const company = { kind: "company" as const, companyUrl: "https://www.linkedin.com/company/acme" };
  assert.equal(authorOf({ ...post, author: { ...company, name: "Acme" } }, UNNAMED), null);
  assert.equal(authorOf({ ...post, excerpt: "" }, UNNAMED)?.commentText, undefined);
  const file = {
    engagers: [
      engager("comment", "2026-10-21T00:00:00.000Z", { commentText: "Congrats", dateKnown: true }),
      engager("like", "2026-10-21T00:00:00.000Z", { dateKnown: false }),
      engager("repost", "2026-10-19T00:00:00.000Z", { dateKnown: true }),
    ],
  };
  const cut = new Date("2026-10-20T00:00:00.000Z");
  const commenters = engagersOf(file, { url: UNNAMED, excerpt: "We shipped" }, cut, ["comment"]);
  assert.equal(commenters.reachedCut, true);
  const [comment] = commenters.candidates;
  assert.deepEqual(comment && postEvidenceOf(comment), {
    url: UNNAMED,
    reaction: "comment",
    commentText: "Congrats",
    postExcerpt: "We shipped",
    author: "Sam Reader",
  });
  const every = engagersOf(file, { url: UNNAMED }, cut, ["like", "comment", "repost"]);
  const read = every.candidates.map((c) => [c.reaction, c.postExcerpt, c.dateKnown]);
  assert.deepEqual(read, [
    ["comment", undefined, true],
    ["like", undefined, false],
  ]);
});

test("an undated engager is dated at the floor, its post's date or the last run's start, never later than the listing; a dated one, or a comment in an older page, keeps its date", () => {
  const floor = new Date("2026-10-20T00:00:00.000Z");
  const listed = new Date("2026-10-31T00:00:00.000Z");
  const base = { ...engager("like", listed.toISOString()), engagedAt: listed, objectUrl: UNNAMED };
  const at = (reaction: string, dateKnown?: boolean, engagedAt = listed) => {
    const candidate: Candidate = {
      ...base,
      reaction,
      engagedAt,
      ...(dateKnown === undefined ? {} : { dateKnown }),
    };
    return stagedAt(candidate, floor).toISOString();
  };
  assert.equal(at("like", false), floor.toISOString());
  assert.equal(at("repost"), floor.toISOString());
  assert.equal(at("like", true), listed.toISOString());
  assert.equal(at("comment"), listed.toISOString());
  const earlier = new Date("2026-10-18T00:00:00.000Z");
  assert.equal(at("like", false, earlier), earlier.toISOString());
});

// The kind web_research (gamma-wr-030): its config, stored canonical; each refusal names its field.
const research = (config: unknown) => parseSourceConfig(sourceKind("web_research"), config);

test("a research config: the focus and the region with their words one space apart, languages and start pages kept in order, a field left empty not stored; it parses to itself", async () => {
  const given = {
    focus: "  makers of   packaging\tfor food ",
    region: "  the  northern coast ",
    languages: ["ES", "pt"],
    startPages: ["https://Directory.example/list?page=2#top", "https://registry.example/a"],
  };
  const kept = {
    focus: "makers of packaging for food",
    region: "the northern coast",
    languages: ["es", "pt"],
    startPages: ["https://directory.example/list?page=2", "https://registry.example/a"],
  };
  assert.deepEqual(await research(given), kept);
  assert.deepEqual(await research(kept), kept);
  const bare = { focus: "abc" };
  assert.deepEqual(await research({ ...bare, region: "  ", languages: [], startPages: [] }), bare);
  // The same page twice is one.
  const twice = ["https://a.example/", "https://a.example/"];
  assert.deepEqual(await research({ ...bare, startPages: twice }), {
    ...bare,
    startPages: ["https://a.example/"],
  });
});

test("a research config is refused, naming its field: a focus of 2 or 301 characters or none, a region of 101, a fourth language, one off the list or twice, a sixth start page, one on linkedin.com, one that is not https, and a field the kind does not have", async () => {
  const ok = { focus: "traders of grain" };
  const refused = (config: unknown, field: string) =>
    assert.rejects(research(config), invalid(field), JSON.stringify(config).slice(0, 80));
  await refused({ focus: "ab" }, "config.focus");
  await refused({ focus: "x".repeat(301) }, "config.focus");
  await refused({ focus: "   " }, "config.focus");
  await refused({}, "config.focus");
  await refused({ ...ok, region: "r".repeat(101) }, "config.region");
  await research({ ...ok, region: "r".repeat(100) });
  await refused({ ...ok, languages: ["en", "fr", "de", "es"] }, "config.languages");
  await refused({ ...ok, languages: ["xx"] }, "config.languages");
  await refused({ ...ok, languages: ["en", "EN"] }, "config.languages");
  await refused({ ...ok, languages: "en" }, "config.languages");
  const pages = Array.from({ length: 6 }, (_, at) => `https://site${at}.example/`);
  await refused({ ...ok, startPages: pages }, "config.startPages");
  await research({ ...ok, startPages: pages.slice(0, 5) });
  for (const page of [
    "https://www.linkedin.com/company/acme",
    "https://linkedin.com/in/jane",
    "https://uk.LinkedIn.com./jobs",
    "http://registry.example/",
    "ftp://registry.example/",
    "registry.example/list",
    "https://user@registry.example/",
    "https://user:secret@registry.example/",
    "https://registry.example:8443/",
    "https://registry.example:443/",
    "https://",
  ]) {
    await refused({ ...ok, startPages: [page] }, "config.startPages");
  }
  await refused({ ...ok, extra: 1 }, "config");
});

test("the hosts never fetched, the social networks, are refused with their subdomains and so is LinkedIn by name; a host that only ends like one is not", () => {
  for (const host of NEVER_FETCHED_HOSTS) {
    assert.equal(startPageOf(`https://${host}/page`), null, host);
    assert.equal(startPageOf(`https://news.${host}/page`), null, `news.${host}`);
  }
  assert.equal(startPageOf("https://lnkd.in/abc"), null);
  assert.equal(startPageOf("https://notlinkedin.com/x"), "https://notlinkedin.com/x");
  assert.equal(startPageOf("https://linkedin.com.example/x"), "https://linkedin.com.example/x");
  assert.equal(startPageOf("https://boxcom.example/"), "https://boxcom.example/");
});

test("the language list is every ISO 639-1 code, 184 of them in two lower-case letters, each once: it names every language and favours none", () => {
  assert.equal(LANGUAGES.length, 184);
  assert.equal(new Set(LANGUAGES).size, 184);
  assert.ok(LANGUAGES.every((code) => /^[a-z]{2}$/.test(code)));
  for (const code of ["en", "es", "zh", "hi", "ar", "sw", "yo", "zu", "is", "mi"]) {
    assert.ok(LANGUAGES.includes(code), code);
  }
});

test("the kind reads through no account and is edited in place, its run the research workflow's, its fire times none; the five before it read through one and keep their config", () => {
  const kind = sourceKind("web_research");
  assert.equal(readsThroughAccount(kind), false);
  assert.equal(kind.configEditable, true);
  assert.equal(kind.cadence, "research");
  assert.ok(isResearchReader(kind.reader) && !isPostsReader(kind.reader));
  assert.deepEqual(kind.schedule({}, new Date()), []);
  for (const name of ["post_engagers", "topic_engagement", "my_post_engagement"]) {
    const before = sourceKind(name);
    assert.equal(readsThroughAccount(before), true, name);
    assert.equal(before.configEditable, undefined, name);
    assert.ok(!isResearchReader(before.reader), name);
  }
  assert.equal(readsThroughAccount(sourceKind("competitor_engagement")), true);
  assert.equal(readsThroughAccount(sourceKind("creator_engagement")), true);
});
