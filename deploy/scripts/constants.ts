// The fixed values of deploy:check (deploy-check.ts), then those of unipile:webhooks.

/**
 * Empty is meant for these, never `fake`: alerts then has no team channel, the browser none (the
 * plain fetch's page is kept), company data no source, the email finder none (enrichment's other
 * sources run), the email verifier none (no address is verified), the mailbox each mailbox's own
 * provider, web search no search.
 */
export const OPTIONAL_SELECTORS: ReadonlySet<string> = new Set([
  "PROVIDER_ALERTS",
  "PROVIDER_BROWSER",
  "PROVIDER_COMPANY_DATA",
  "PROVIDER_EMAIL_FINDER",
  "PROVIDER_EMAIL_VERIFIER",
  "PROVIDER_MAILBOX",
  "PROVIDER_WEB_SEARCH",
]);

/** The adapter a server never runs, in a selector or a list. */
export const FAKE = "fake";

/** What separates the names of a PROVIDER_ list and of an enrichment list. */
export const LIST_SEPARATOR = ",";

/**
 * The adapters a server may name in each PROVIDER_ selector and list (gamma-en-100: every port's), by
 * variable, the fake aside, each with the variables it cannot run without: its `requires` in
 * core/packages/providers, in that order; none for an adapter that declares none. Deploy scripts
 * import no module: providers' tests/deploy-table.test.ts keeps this in step.
 */
export const ADAPTER_VARIABLES: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  PROVIDER_ALERTS: { webhook: ["ALERTS_WEBHOOK_URL"] },
  PROVIDER_APP_MAIL: { smtp: ["SMTP_HOST", "SMTP_PORT", "MAIL_FROM"] },
  PROVIDER_AUTH: { "better-auth": ["AUTH_SECRET", "AUTH_BASE_URL"] },
  PROVIDER_BROWSER: { playwright: ["BROWSER_WS_URL"] },
  PROVIDER_COMPANY_DATA: {
    "companies-house": ["COMPANIES_HOUSE_API_KEY"],
    diffbot: ["DIFFBOT_TOKEN"],
    "google-kg": ["GOOGLE_KG_API_KEY"],
    pdl: ["PDL_API_KEY"],
    wikidata: ["WIKIDATA_CONTACT"],
  },
  PROVIDER_EMAIL_FINDER: {
    hunter: ["HUNTER_API_KEY"],
    prospeo: ["PROSPEO_API_KEY"],
    snov: ["SNOV_CLIENT_ID", "SNOV_CLIENT_SECRET"],
    tomba: ["TOMBA_KEY", "TOMBA_SECRET"],
  },
  PROVIDER_EMAIL_VERIFIER: {
    mailboxvalidator: ["MAILBOXVALIDATOR_API_KEY"],
    quickemailverification: ["QUICKEMAILVERIFICATION_API_KEY"],
    reoon: ["REOON_API_KEY"],
    verifalia: ["VERIFALIA_USERNAME", "VERIFALIA_PASSWORD"],
    zerobounce: ["ZEROBOUNCE_API_KEY"],
  },
  PROVIDER_FILES: { s3: ["S3_ENDPOINT", "S3_BUCKET"] },
  PROVIDER_LINKEDIN: {
    unipile: [
      "UNIPILE_BASE_URL",
      "UNIPILE_API_KEY",
      "UNIPILE_WEBHOOK_SECRET",
      "UNIPILE_CURSOR_SECRET",
    ],
  },
  PROVIDER_LLM: { anthropic: ["LLM_ANTHROPIC_API_KEY"], openai: ["LLM_OPENAI_API_KEY"] },
  /** The fake alone so far: empty, the mailbox port picks each mailbox's own provider. */
  PROVIDER_MAILBOX: {},
  PROVIDER_WEB_SEARCH: { brave: ["BRAVE_API_KEY"] },
};

/**
 * The names each enrichment list may hold: `company-data` (the company list), `email-finder` (the
 * email list, gamma-en-080) and the sources core/modules/enrichment defines of the list's kind
 * (its domain/sources/). Enrichment's tests/deploy-table.test.ts keeps this in step; a source
 * added later adds its name here.
 */
export const SOURCE_NAMES: Readonly<Record<string, readonly string[]>> = {
  ENRICHMENT_COMPANY_SOURCES: ["company-data", "linkedin", "web-search", "website"],
  ENRICHMENT_PERSON_SOURCES: ["country-ai"],
  ENRICHMENT_EMAIL_SOURCES: [
    "email-finder",
    "linkedin-contact-info",
    "reply",
    "website",
    "pattern",
  ],
};

// unipile:webhooks (unipile-webhooks.ts): the webhooks of the Unipile adapter's README, "Webhooks".

/** The commands, in the usage's order. */
export const COMMANDS = ["check", "list", "register", "remove"] as const;

/** Unipile's API under UNIPILE_BASE_URL, and its webhooks' route there. */
export const UNIPILE_API = "/api/v1";
export const WEBHOOKS_ROUTE = "/webhooks";

/** What the path of UNIPILE_NOTIFY_URL ends in: linkedin's webhook (`/api` first via the web). */
export const NOTIFY_PATH = "/v1/linkedin/webhooks/unipile";

/** The adapter PROVIDER_LINKEDIN names for the apps to use Unipile. */
export const UNIPILE_ADAPTER = "unipile";

/** The shortest UNIPILE_WEBHOOK_SECRET and UNIPILE_CURSOR_SECRET the adapter starts with. */
export const SECRET_MIN_CHARS = 32;

/** Each webhook is named this and its source; register and remove touch these names only. */
export const WEBHOOK_PREFIX = "whytide-";
/** The header each webhook carries, set to UNIPILE_WEBHOOK_SECRET, and its body's format. */
export const WEBHOOK_HEADER = "Unipile-Auth";
export const WEBHOOK_FORMAT = "json";

/** The three sources and their events; account_status all, since its default leaves some out. */
export const WEBHOOK_SOURCES: readonly { source: string; events: readonly string[] }[] = [
  { source: "messaging", events: ["message_received"] },
  { source: "users", events: ["new_relation"] },
  {
    source: "account_status",
    events: [
      "ok",
      "reconnected",
      "creation_success",
      "sync_success",
      "credentials",
      "error",
      "stopped",
      "deleted",
      "connecting",
      "creation_fail",
      "permissions",
    ],
  },
];

/** The webhooks one page of the list asks for, and the pages one listing reads at most. */
export const LIST_PAGE = 100;
export const LIST_PAGES_MAX = 50;

/** How long one request may take, its answer read to the end included; the adapter's bound. */
export const TIMEOUT_MS = 30_000;
/** The longest answer read, 1 MiB, as the adapter; a longer one is refused unread. */
export const MAX_ANSWER_BYTES = 1024 * 1024;
/** A redirect's statuses: never followed, so that the key never leaves for another host. */
export const REDIRECT_STATUS = { min: 300, max: 399 } as const;
/** Unipile's short error type, the one part of an error's body ever printed. */
export const ERROR_TYPE = /^errors\/[a-z0-9_]{1,64}$/;
/** A network error's code as fetch gives it (`ECONNREFUSED`), printed only in this form. */
export const NETWORK_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * The tests' switch, read from the process's environment only, never the env file: set to 1, it
 * lets UNIPILE_BASE_URL be http on TEST_HTTP_HOST, the fake Unipile a test starts. Off by default.
 */
export const TEST_HTTP_SWITCH = "UNIPILE_WEBHOOKS_TEST_HTTP";
export const TEST_HTTP_HOST = "127.0.0.1";
