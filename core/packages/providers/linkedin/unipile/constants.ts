// The Unipile adapter's constants. The post links listPostEngagers reads are the six forms signals
// accepts: POST_PATHS of core/modules/signals/sources/post_engagers/post-url.ts, copied here with the
// kind and the id captured, since providers never imports a module. A change to one is a change to
// the other.

/** The kind of post a link names. */
const KIND = "(activity|share|ugcPost)";
/** A colon of the URN, plain or percent-encoded. */
const COLON = "(?::|%3[Aa])";

/**
 * The path of a post's link, its kind and id captured: /posts/<slug>-<kind>-<id>-<code>, where the
 * greedy slug leaves the link its last -<kind>-<id>-, so that a slug word such as market-share-40
 * never counts; or /feed/update/urn:li:<kind>:<id>.
 */
export const POST_PATHS: readonly RegExp[] = [
  new RegExp(`^/posts/[\\w%.~-]+-${KIND}-(\\d{1,30})-[\\w-]+/?$`),
  new RegExp(`^/feed/update/urn${COLON}li${COLON}${KIND}${COLON}(\\d{1,30})/?$`),
];

/**
 * The kind Unipile is asked for by its number, as before share and ugcPost links were read, so that
 * a run's cursor, which keeps that number as `post`, still resumes. Any other kind is asked for as
 * urn:li:<kind>:<id>: Unipile answers 404 for a share's number (checked on 2026-10-28).
 */
export const ACTIVITY = "activity";

/** A redirect's statuses: the client never follows one, so that the key never leaves for its host. */
export const REDIRECT_STATUS = { min: 300, max: 399 } as const;

/**
 * A network error's code as Node's fetch gives it in `error.cause.code` (`ECONNRESET`,
 * `UND_ERR_SOCKET`): kept in a provider error only in this short upper-case form, never the message.
 */
export const NETWORK_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
