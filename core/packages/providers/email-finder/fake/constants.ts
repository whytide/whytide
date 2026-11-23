// The fake's values (README.md "The fake"): what joins the two names in the address it makes, what
// it drops from a name, and the details when a test's failNext gives none, as an adapter's codes
// carry them: the seconds a rate limit asks to wait, and a provider error's status.
export const NAME_JOIN = ".";
/** A name's marks, once it is decomposed (NFKD): é is e and a mark. */
export const MARKS = /\p{M}/gu;
/** What else a name loses in the address: anything but the letters a to z and digits. */
export const NOT_IN_ADDRESS = /[^a-z0-9]/g;
export const RETRY_AFTER_SEC = 60;
export const PROVIDER_ERROR_STATUS = 500;
