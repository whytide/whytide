// email's constants (README.md "Decided here"). Neither the connect's life nor the list of public
// providers is in the sources, beyond the two domains RB-12.1.2 names.

/** How long a connect waits for its callback: past it, the member starts again. */
export const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

/** Public providers' domains: a mailbox there is a free consumer address, for replies only (F11 R2). */
export const FREE_CONSUMER_DOMAINS: readonly string[] = Object.freeze([
  "aol.com",
  "gmail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "googlemail.com",
  "hotmail.co.uk",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mac.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "yahoo.co.uk",
  "yahoo.com",
  "yandex.com",
  "ymail.com",
  "zoho.com",
]);

/** The purposes the tokens are sealed for and the PKCE verifier derived for (platform "Secrets at rest"). */
export const TOKENS_PURPOSE = "email.mailbox_tokens";
export const VERIFIER_PURPOSE = "email.pkce_verifier";
/** The nonce of a connect's state: 32 random bytes, 43 characters in base64url. */
export const NONCE_BYTES = 32;
/** A connect's state, `<workspaceId>.<nonce>`: the patterns of its workspace's id and of its nonce. */
export const STATE_WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const STATE_NONCE = /^[A-Za-z0-9_-]{43}$/;
/** The web page the provider sends the browser back to: the path of the consent's redirect address. */
export const CALLBACK_PATH = "/email/callback";
/** An access token this close to its expiry is refreshed before use. */
export const ACCESS_MARGIN_MS = 60_000;
/** The indexes a store breaks (the migration email_mailboxes): one per member, one per address. */
export const OWNER_INDEX = "mailboxes_owner_connected";
export const ADDRESS_INDEX = "mailboxes_address_connected";
