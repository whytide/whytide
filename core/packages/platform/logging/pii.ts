// The PII registry behind the log redaction (docs/rules/coding.md §9; security §2, §4): the keys that
// hold a person's name, contact, URL or words, and the keys that hold a credential, in snake_case and
// camelCase; and the key suffixes that hold a provider reference, a token or a secret, whatever the
// word before them. The list is the floor: a host adds keys through createLogger({ redact }); the
// log-schema check in schema.ts is the proof.
const SNAKE = [
  "first_name",
  "last_name",
  "full_name",
  "display_name",
  "given_name",
  "family_name",
  "name",
  "email",
  "emails",
  "email_address",
  "phone",
  "phone_number",
  "mobile",
  "linkedin_url",
  "profile_url",
  "avatar_url",
  "photo_url",
  "picture",
  "website",
  "body",
  "message_body",
  "text",
  "content",
  "subject",
  "headline",
  "summary",
  "about",
  "bio",
  "title",
  "company_name",
  "location_text",
  "location_country",
  "provider_refs",
  "hash",
  "why",
  "reason_text",
  "good_reason_text",
  "ip",
  "ip_address",
  "user_agent",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "secret",
  "client_secret",
  "private_key",
  "authorization",
  "cookie",
  "set_cookie",
  "session",
  "password",
  "passphrase",
];
const camel = (key: string) =>
  key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

export const piiKeys: readonly string[] = [...new Set([...SNAKE, ...SNAKE.map(camel)])];

/** A key ending in one of these holds a provider reference, a token or a secret: `account_ref`, `oauthToken`. */
const SUFFIXES = ["_ref", "_token", "_secret"];
export const piiKeySuffixes: readonly string[] = [...SUFFIXES, ...SUFFIXES.map(camel)];
