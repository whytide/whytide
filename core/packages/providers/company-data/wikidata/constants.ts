// The wikidata adapter's hosts, bounds and queries (README.md "Calls", "Mapping"): Wikidata's query
// service and its API, the User-Agent Wikimedia's policy asks for, one request a second, and the
// properties a company's facts are read from.

/** The query service and the API: the adapter's two fixed hosts. */
export const SPARQL_URL = "https://query.wikidata.org/sparql";
export const API_URL = "https://www.wikidata.org/w/api.php";

/**
 * The User-Agent, `<product> (<WIKIDATA_CONTACT>)`, as Wikimedia's policy asks: the client, its
 * version and how to reach its operator.
 */
export const PRODUCT = "Whytide-company-data/1.0";
/** WIKIDATA_CONTACT: an email address or an https page, nothing a header or its comment could break on. */
export const CONTACT =
  /^(?:[^\s@()<>;,"\\]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https:\/\/[^\s()<>;,"\\]+)$/;
export const CONTACT_MAX = 200;

/** How long one request may take, its answer read to the end included. */
export const TIMEOUT_MS = 10_000;
/** The longest answer read, 1 MiB; a longer one is refused unparsed. */
export const MAX_ANSWER_BYTES = 1_048_576;
/** The seconds a 429 asks to wait when its Retry-After gives none. */
export const RETRY_AFTER_SEC = 60;
/** At most one request a second per process: the next starts a second after the last one started. */
export const MIN_INTERVAL_MS = 1_000;

export const SPARQL_JSON = "application/sparql-results+json";
export const JSON_TYPE = "application/json";
export const FORM = "application/x-www-form-urlencoded";
/** The search for a name: wbsearchentities, items whose English label or alias starts with it. */
export const SEARCH = {
  action: "wbsearchentities",
  language: "en",
  uselang: "en",
  type: "item",
  limit: "10",
  format: "json",
} as const;
/** The most search results and query rows read: an answer past them is off the documented shape. */
export const MAX_CANDIDATES = 50;
export const MAX_ROWS = 500;

/** An item's id as the search gives it, and as the query service names it. */
export const ITEM_ID = /^Q[1-9][0-9]{0,11}$/;
export const ENTITY = "http://www.wikidata.org/entity/";
/** What a slug may hold to go into a query as a literal: the port's slug characters. */
export const SLUG_LITERAL = /^[\w%.~-]{1,200}$/;
/** The forms a website's address takes in P856: either scheme, with or without www., with or without a slash. */
export const WEBSITE_SCHEMES = ["http://", "https://"] as const;
export const WEBSITE_PREFIXES = ["", "www."] as const;
export const WEBSITE_ENDS = ["", "/"] as const;
/** A P571 time's year: a year of the common era, the sign-less form. */
export const YEAR = /^(\d{1,4})-/;

/** The facts' rows in the query's answer, by the `?p` each carries. */
export const ROW = {
  item: "item",
  website: "P856",
  linkedin: "P4264",
  industry: "P452",
  employees: "P1128",
  country: "P297",
  founded: "P571",
  description: "description",
} as const;

/** The items a selection keeps, at most two: two are already ambiguous. */
export const ITEMS_AT_MOST = 2;
/** By LinkedIn company ID (P4264), its slug as given and in lower case. */
export const BY_LINKEDIN = "?item wdt:P4264 ?id .";
/** By official website (P856), at its host. */
export const BY_WEBSITE = "?item wdt:P856 ?site .";
/** Among the search's items, a business: an instance of business (Q4830453) or of a subclass of it. */
export const A_BUSINESS = "FILTER EXISTS { ?item wdt:P31/wdt:P279* wd:Q4830453 }";
/** In the country of the hint: P17's ISO 3166-1 alpha-2 code (P297). */
export const IN_COUNTRY = "FILTER EXISTS { ?item wdt:P17/wdt:P297 ?country }";
/**
 * The facts of the items kept, one row per value, `?p` naming the property: the item itself, then
 * P856, P4264, P452's English label (`?of` the industry), P1128 with its point in time (P585) unless
 * deprecated, P17's P297, P571 and the English description. Best-ranked values (`wdt:`) elsewhere.
 */
export const FACTS = `{ BIND("item" AS ?p) }
  UNION { ?item wdt:P856 ?value . BIND("P856" AS ?p) }
  UNION { ?item wdt:P4264 ?value . BIND("P4264" AS ?p) }
  UNION { ?item wdt:P452 ?of . ?of rdfs:label ?value . FILTER(LANG(?value) = "en") BIND("P452" AS ?p) }
  UNION { ?item p:P1128 ?statement . ?statement ps:P1128 ?value ; wikibase:rank ?rank .
          FILTER(?rank != wikibase:DeprecatedRank) OPTIONAL { ?statement pq:P585 ?time } BIND("P1128" AS ?p) }
  UNION { ?item wdt:P17/wdt:P297 ?value . BIND("P297" AS ?p) }
  UNION { ?item wdt:P571 ?value . BIND("P571" AS ?p) }
  UNION { ?item schema:description ?value . FILTER(LANG(?value) = "en") BIND("description" AS ?p) }`;
