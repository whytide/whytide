// The LinkedIn port's ceilings on what a send carries (README.md "Sending"): bounds that keep a
// vendor call sane, never a caller's limit. A caller's own limits are lower: messaging's
// LINKEDIN_NOTE_LIMIT for a note, the step's target length for a message. Then the bounds of the
// events parseWebhook gives (README.md "Events"), above LinkedIn's own limits, so that a real
// message never fails the check. Then the post reads' bounds and the links they take and give
// (README.md "Posts"): a character is a code point, so an emoji counts once.

/** A connection request's note: 300 characters, LinkedIn's longest, on Premium (RB-11.2.5). */
export const NOTE_MAX_CHARS = 300;
/** A message: the hard maximum of briefs RB-9.1.2. */
export const MESSAGE_MAX_CHARS = 1900;
/** The step's idempotency key (briefs RB-1.2.4). */
export const IDEMPOTENCY_KEY_MAX_CHARS = 128;
/** An event's key, the provider's event or message id: the length of a ref. */
export const EVENT_KEY_MAX_CHARS = 256;
/** A received message's text, in characters: not in the sources, above LinkedIn's own limit. */
export const EVENT_TEXT_MAX_CHARS = 20_000;
/** A received message's attendees: not in the sources, above LinkedIn's own limit. */
export const EVENT_ATTENDEES_MAX = 50;

/** A post's excerpt: its first 500 characters (briefs RB-4.4.3). */
export const POST_EXCERPT_MAX_CHARS = 500;
/** The words of a phrase searchPosts looks for (briefs RB-4.1.1). */
export const POST_PHRASE_MAX_WORDS = 5;
/** The characters of that phrase: not in the sources. */
export const POST_PHRASE_MAX_CHARS = 100;
/** The posts one page answers at most: not in the sources. */
export const POSTS_PAGE_MAX = 50;

/** The kind of post a link names. */
const KIND = "(activity|share|ugcPost)";
/** A colon of the URN, plain or percent-encoded. */
const COLON = "(?::|%3[Aa])";

/**
 * The path of a post's link, its kind and id captured: /posts/<slug>-<kind>-<id>-<code>, where the
 * greedy slug leaves the link its last -<kind>-<id>-, so that a slug word such as market-share-40
 * never counts; or /feed/update/urn:li:<kind>:<id>. The forms listPostEngagers reads on Unipile and
 * a post's `postUrl` takes; the six signals accepts (POST_PATHS of
 * core/modules/signals/sources/post_engagers/post-url.ts, copied here since providers never imports
 * a module). A change to one is a change to the other.
 */
export const POST_PATHS: readonly RegExp[] = [
  new RegExp(`^/posts/[\\w%.~-]+-${KIND}-(\\d{1,30})-[\\w-]+/?$`),
  new RegExp(`^/feed/update/urn${COLON}li${COLON}${KIND}${COLON}(\\d{1,30})/?$`),
];

/**
 * The path of an author's page, its id captured: a member's /in/<id>, a company's /company/<id>, the
 * id of the characters a post link's slug takes, a dot included (/company/booking.com, /in/jane.doe).
 */
export const AUTHOR_PATHS = {
  member: /^\/in\/([\w%.~-]{1,200})\/?$/,
  company: /^\/company\/([\w%.~-]{1,200})\/?$/,
} as const;

/** A company page's description (getCompany): its first 2,000 characters, as company data's. */
export const COMPANY_DESCRIPTION_MAX_CHARS = 2000;
/** A company page's name and industry: not in the sources, above LinkedIn's own lengths. */
export const COMPANY_NAME_MAX_CHARS = 300;
export const COMPANY_INDUSTRY_MAX_CHARS = 200;
/** A founding year, as company data bounds one. */
export const COMPANY_FOUNDED_YEAR = Object.freeze({ min: 1, max: 9999 } as const);
/** ISO 3166-1 alpha-2, as two capital letters: the form, not the list. */
export const COUNTRY_CODE = /^[A-Z]{2}$/;

/**
 * getContactEmails (gamma-en-087; README.md "What the port will never have", the owner's exception
 * of 2026-11-13): the email addresses of a member's "Contact info", three at most, each at most
 * EMAIL_MAX_CHARS, RFC 5321's longest path.
 */
export const CONTACT_EMAILS_MAX = 3;
export const EMAIL_MAX_CHARS = 254;
