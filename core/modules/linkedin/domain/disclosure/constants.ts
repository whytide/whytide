// The risk disclosure for sending (docs/concepts.md "Risk disclosure"): its version, which the
// screen's text is, and which an account's owner must have accepted, with the personal-account
// confirmation, before the account sends (domain/send/state.ts). A new text is a higher version, and
// every account is then refused sends until its owner accepts it (F10 R9): compare with this
// constant, never with a literal.

/** The disclosure's current version; 1 is alpha's, which covers reads only. */
export const DISCLOSURE_VERSION = 2;

/** The version of an account none has accepted for sending: alpha's, the column's default. */
export const READS_ONLY_VERSION = 1;
