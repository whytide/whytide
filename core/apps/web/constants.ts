// The web host's constants (docs/rules/coding.md "constants").

/**
 * The pages whose address holds a secret, answered by proxy.ts with `referrer-policy: no-referrer`
 * so that no request from them sends it on as a Referer: the sign-in confirm page (the auth port's
 * AUTH_LINK_CONFIRM_PATH), a link's token, and email's callback page (its CALLBACK_PATH), a
 * provider's code. A host never imports a module's files, so each path is written here.
 */
export const NO_REFERRER: ReadonlySet<string> = new Set(["/sign-in/confirm", "/email/callback"]);

/**
 * The viewer's time zone (README "The shell"; gamma-en-100): the cookie src/shell/time-zone.tsx
 * writes from the browser's own zone, and src/i18n/request.ts gives next-intl, a year long.
 */
export const TIME_ZONE_COOKIE = "whytide_time_zone";
export const TIME_ZONE_COOKIE_MAX_AGE = 31_536_000;
/** An IANA zone's name as the cookie may carry it, `Asia/Kolkata` or `Etc/GMT+5`, 64 characters at most. */
export const TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/;
