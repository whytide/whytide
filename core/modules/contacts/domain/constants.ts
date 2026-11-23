// contacts' limits of a lead's source, of the qualification batch's read, of a person's profile
// fields, of enrichment's hold and of a company's facts (rules.ts; README.md "Public interface" and
// "Routes"), beside the code that checks them.

/** The longest label a lead's source takes, trimmed: its name as its module shows it. */
export const SOURCE_LABEL_MAX = 200;

/** The most hard-filter reasons leadsPendingQualification takes (leads.ts; title-check-ai). */
export const PENDING_REASONS_MAX = 10;

/** The most current snapshots leadsPendingQualification takes (leads.ts; title-check-ai). */
export const PENDING_SNAPSHOTS_MAX = 500;

/**
 * The most source refs leadsPendingQualification's `pendingSources` or `decidedSources` takes
 * (leads.ts; review-gaps-2): the agents' sources of a workspace, 3 live agents of 10 at most today.
 */
export const PENDING_SOURCES_MAX = 1000;

/**
 * A lead's first signal source's ref in its `sources` column, as SQL reads it (leads.ts): the jsonpath
 * of `firstSignalSource` (lead.ts), the first entry of kind `signal`, in the array's order.
 */
export const FIRST_SIGNAL_PATH = '$[*] ? (@.kind == "signal").ref';

/** The longest URL a lead's source takes. */
export const SOURCE_URL_MAX = 2048;

/**
 * A source's `ref` as the list's `source` filter takes it: an import job's id or a signal source's,
 * a short id of letters, digits and `_`.
 */
export const SOURCE_REF = /^[A-Za-z0-9_]{1,64}$/;

/**
 * The longest value of each profile field a source brings or a member types, once trimmed: the
 * LinkedIn port's limits (core/packages/providers/linkedin/port.ts). The columns are text.
 */
export const PERSON_FIELD_MAX = {
  firstName: 100,
  lastName: 100,
  headline: 300,
  title: 300,
  companyName: 300,
  locationText: 300,
} as const;

/** The profile fields a member edits on the lead page (person-edit.ts), in the form's order. */
export const EDITABLE_FIELDS = [
  "firstName",
  "lastName",
  "headline",
  "title",
  "companyName",
  "locationText",
] as const satisfies readonly (keyof typeof PERSON_FIELD_MAX)[];
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/**
 * CONTACTS_ENRICHMENT_HOLD_MINUTES (settings.ts; hold.ts, gamma-en-040): how long a new lead waits
 * for enrichment before its first judgement, by default and at most (a day); 0 is no hold.
 */
export const HOLD_MINUTES_DEFAULT = 60;
export const HOLD_MINUTES_MAX = 1440;

/** The most leads leadsHeldForEnrichment answers, and releaseEnrichmentHold takes, in one call. */
export const HELD_LEADS_MAX = 100;

/** A minute, in milliseconds: the hold's unit. */
export const MINUTE_MS = 60_000;

/** A company's description at most, in characters, as the column's CHECK holds it (gamma-en-040). */
export const COMPANY_DESCRIPTION_MAX = 2000;

/** A company's headcount at most: the integer column's largest value. */
export const EMPLOYEE_COUNT_MAX = 2_147_483_647;

/**
 * The codes recordPersonCountry takes (person-country.ts): icp's COUNTRIES, the 249 ISO 3166-1
 * alpha-2 codes officially assigned (core/modules/icp/domain/lists.ts), copied, as contacts does not
 * depend on icp; tests/provenance.test.ts keeps the two lists equal.
 */
export const COUNTRIES: readonly string[] = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS " +
  "BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE " +
  "EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM " +
  "HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC " +
  "LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA " +
  "NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO " +
  "TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

/**
 * The place list (gamma-en-075; README "The place list"): data/places.tsv.gz, written by
 * `pnpm -F contacts places:build` (scripts/places-build.ts) and read by domain/places.ts. Its lines
 * start with a tag: comment lines first, the first naming the source and its download date, then
 * one line per first-level division and one per place, their fields separated by tabs.
 */
export const PLACES_FILE = "data/places.tsv.gz";
export const PLACES_COMMENT = "#";
/** A division: its country, its GeoNames code, its name and its ASCII name (empty when the same). */
export const PLACES_DIVISION = "D";
/** A place: its name, its ASCII name (empty when the same), country, division code, population. */
export const PLACES_PLACE = "P";
export const PLACES_SEPARATOR = "\t";

/**
 * A location's words dropped before it is read (countries.ts): one prefix, then one suffix, the
 * longest first, case aside. "Metropolitan Region" is LinkedIn's for Paris (decided in gamma-en-075).
 */
export const LOCATION_PREFIXES = ["Greater"] as const;
export const LOCATION_SUFFIXES = [
  "Metropolitan Region",
  "Metropolitan Area",
  "Metro Area",
  "Bay Area",
  "Area",
  "Region",
] as const;

/**
 * A city's name is ambiguous when a place of that name in another country has more than this share
 * of the largest one's population (countries.ts).
 */
export const CITY_RIVAL_SHARE = 0.1;

/** The US states' and DC's two-letter codes, GeoNames' division codes for them too. */
export const US_STATES: readonly string[] = (
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM " +
  "NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY"
).split(" ");
/** The Canadian provinces' and territories' two-letter codes, as GeoNames' division codes. */
export const CANADIAN_PROVINCES: Readonly<Record<string, string>> = {
  AB: "01",
  BC: "02",
  MB: "03",
  NB: "04",
  NL: "05",
  NS: "07",
  ON: "08",
  PE: "09",
  QC: "10",
  SK: "11",
  YT: "12",
  NT: "13",
  NU: "14",
};

/**
 * Words that name no place (gamma-en-075): a location made of them only has no country, and
 * enrichment's country-ai asks no model for it. Read case aside; "Asia" is also a town in GeoNames.
 */
export const NO_PLACE_WORDS: readonly string[] = [
  "remote",
  "worldwide",
  "global",
  "anywhere",
  "emea",
  "apac",
  "latam",
  "europe",
  "asia",
  "africa",
];

/** The persons one batch of `pnpm -F contacts countries:backfill` reads (gamma-en-075). */
export const BACKFILL_BATCH = 500;

/** An email address's longest form, RFC 5321's path (emails.ts; the email-verifier port's ADDRESS_MAX). */
export const EMAIL_MAX = 254;

/**
 * An email address as contacts hashes one (emails.ts), once trimmed and in lower case: the
 * email-verifier port's ADDRESS, the form every address enrichment keeps has. A plain local part of
 * letters, digits and `_'+-`, dot-separated, at a host name of two labels or more, the last starting
 * with a letter. Linear: a dot separates each repetition.
 */
export const EMAIL_ADDRESS = /^[a-z0-9_'+-]+(?:\.[a-z0-9_'+-]+)*@(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/;

/**
 * The persons of one company that `findPersonsByNameAtCompany` reads at most (gamma-wr-060): a company
 * has a few dozen persons in a workspace, so a company with more is read as far as this and no further.
 */
export const COMPANY_PERSONS_MATCHED_MAX = 500;
/** The longest name that function takes, in characters: a person's `name` field's own limit. */
export const NAME_MATCH_MAX = 200;
