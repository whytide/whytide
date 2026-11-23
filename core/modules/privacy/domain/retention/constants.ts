// The 30-day rule's values (README.md "The 30-day rule"; the roadmap's "Rules we keep even here"):
// fixed, with no setting. Plain values only: the workflow's sandbox imports them too.

/** A person no channel touched this many days after being found is deleted. */
export const RETENTION_NEVER_CONTACTED_DAYS = 30;

/** The 27 members of the EU, by ISO 3166-1 alpha-2 code (Greece is GR). */
const EU = "AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK";
/** The EU's regions with codes of their own: Åland, the French overseas regions, Saint Martin. */
const EU_REGIONS = "AX GF GP MF MQ RE YT";
/** The rest of the EEA: Iceland, Liechtenstein, Norway, the stricter reading (gamma-p7-010). */
const EEA = "IS LI NO";
/** The United Kingdom. */
const UK = "GB";

/** Where the rule applies; a person whose country is unknown counts too (candidates.ts). */
export const RETENTION_EU_UK_COUNTRIES: ReadonlySet<string> = new Set(
  [EU, EU_REGIONS, EEA, UK].join(" ").split(" "),
);

/** The deletions of one workspace in one run at most; the rest wait for the next day. */
export const RETENTION_MAX_PER_RUN = 1000;

/** The wait between a run's deletions and the sweep of rows written for them since. */
export const RETENTION_SWEEP_DELAY_MINUTES = 15;

/** The job's `performed_by` in erasure_log. */
export const RETENTION_OPERATOR = "retention";

/** The schedule's time, daily, `HH:MM` in UTC. */
export const RETENTION_AT_UTC = "03:15";

/** The persons one read takes, in a tenant run of its own: contacts' listPersons takes 100 at most. */
export const RETENTION_PAGE = 100;

export const MS_PER_MINUTE = 60_000;
export const MS_PER_DAY = 86_400_000;
