// The web_research kind's constants (README.md "Kinds"; gamma-wr-030): the bounds of its fields, the
// list of languages, the hosts a start page may never be. No import: the screen reads them too.

/** What to look for, in characters, its words one space apart. */
export const FOCUS = { min: 3, max: 300 } as const;
/** The part of the country to look in, in characters. */
export const REGION_MAX_CHARS = 100;
/** The languages a source names at most. */
export const LANGUAGES_MAX = 3;
/** The start pages a source names at most. */
export const START_PAGES_MAX = 5;

/**
 * The languages a source may name, every ISO 639-1 code, so that the list names every language and
 * favours none; the search port takes any code of this form (gamma-wr-010). The screen names each in
 * the member's locale with Intl.DisplayNames.
 */
export const LANGUAGES: readonly string[] = Object.freeze(
  (
    "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy " +
    "da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu " +
    "hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb " +
    "lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om " +
    "or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw " +
    "ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu"
  ).split(" "),
);

/**
 * The hosts a start page is never: the social networks, which a run never fetches, each with its
 * subdomains. LinkedIn is refused by name too (LINKEDIN_DOMAINS), whatever else this list holds.
 */
export const NEVER_FETCHED_HOSTS: readonly string[] = Object.freeze([
  ...["facebook.com", "fb.com", "fb.me", "instagram.com", "threads.net", "x.com", "twitter.com"],
  ...["t.co", "tiktok.com", "youtube.com", "youtu.be", "pinterest.com", "snapchat.com"],
  ...["reddit.com", "tumblr.com", "vk.com", "weibo.com", "telegram.org", "t.me", "wa.me"],
  ...["whatsapp.com", "discord.com", "discord.gg", "quora.com", "mastodon.social"],
]);

/** LinkedIn's domains, by name: a start page on one, or on a subdomain of one, is refused. */
export const LINKEDIN_DOMAINS: readonly string[] = Object.freeze(["linkedin.com", "lnkd.in"]);
