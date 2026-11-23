// The research plan's constants (README.md "Web research"; gamma-wr-040). No import: the schema, the
// gates and the tests read them, and the workflow's sandbox imports none of this folder.

/** The words of one language a plan gives at most, each of 1 to WORD_MAX_CHARS characters. */
export const WORDS_PER_LANGUAGE_MAX = 40;
export const WORD_MAX_CHARS = 100;
/** The languages a plan gives words in at most: the source names 3 at most, the kind's list is longer. */
export const WORD_LANGUAGES_MAX = 8;
/**
 * The role words a plan gives for one language at most, each of 1 to ROLE_WORD_MAX_CHARS characters
 * (gamma-wr-090): the audience's titles said as people of the trade say them, and none names a person.
 */
export const ROLE_WORDS_PER_LANGUAGE_MAX = 20;
export const ROLE_WORD_MAX_CHARS = 60;
/** The source types a plan picks at most, and the queries it writes at most. */
export const PLAN_PLACES_MAX = 20;
export const PLAN_QUERIES_MAX = 100;
/** A query as the model writes it, before the gates: the port's own bound is applied by the gate. */
export const PLAN_QUERY_INPUT_CHARS = 1_000;
/** The queries the source asked that the plan is told of, the newest first. */
export const ASKED_IN_INPUT_MAX = 200;
/**
 * What the source's earlier runs found, as the plan reads it (gamma-wr-051): the found companies counted
 * at most (the newest), and the towns of the fitting ones told at most, the most common first.
 */
export const FOUND_ROWS_MAX = 2_000;
export const FOUND_TOWNS_MAX = 50;
/** A text of the input, in characters: Company Knowledge's longest field is 2,000. */
export const INPUT_TEXT_MAX = 2_100;
/** A list of the input's items, and an item's characters. */
export const INPUT_ITEMS_MAX = 50;
export const INPUT_ITEM_MAX = 300;
/** A source type's two texts for the plan, in characters. */
export const PLACE_TEXT_MAX = 400;

/** The gates' names, which `signal_research_plans.refused` counts by. */
export const PLAN_GATES = [
  "place",
  "country",
  "language",
  "query",
  "recheck",
  "duplicate",
  "role_word",
] as const;
export type PlanGate = (typeof PLAN_GATES)[number];

/** What a source type's page is for, the next task's way to read it (README.md "Web research"). */
export const PAGE_KINDS = ["company_site", "company_list", "notice"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** The count a plan adds to its run: the queries it kept and the ones the gates refused. */
export const COUNT_QUERIES_PLANNED = "queries_planned";
export const COUNT_QUERIES_REFUSED = "queries_refused";

/**
 * SIGNALS_RESEARCH_RECHECK_DAYS's default (settings.ts, README.md "Settings"; gamma-wr-040): the days
 * during which a query a source asked is not asked again, and is told to the plan as asked.
 */
export const RESEARCH_RECHECK_DAYS = { default: 180 } as const;

/**
 * SIGNALS_RESEARCH_SEARCHES_PER_RUN's default (settings.ts, README.md "Settings"; gamma-wr-041): the
 * searches one research run asks at most, its failed ones included; at it the run ends `done` with
 * `counts.budget_reached`.
 */
export const RESEARCH_SEARCHES_PER_RUN = { default: 60 } as const;

/** Results asked of each search, and its page: the first (gamma-wr-041). */
export const SEARCH_RESULTS_COUNT = 10;
export const SEARCH_PAGE = 1;

/** The search's counts on the run: asked and answered, the results kept, failed, adapters spent. */
export const COUNT_SEARCHES_ASKED = "searches_asked";
export const COUNT_SEARCH_RESULTS = "search_results";
export const COUNT_SEARCHES_FAILED = "searches_failed";
export const COUNT_ADAPTERS_SPENT = "adapters_spent";
/** The search gate's refusal count: a query that holds an email address, a link or a phone number. */
export const COUNT_SEARCHES_REFUSED_CONTACT = "searches_refused_contact";

/** The run's end by its searches' limit (the same count the LinkedIn runs use, domain/constants.ts). */
export const COUNT_BUDGET_REACHED = "budget_reached";

/**
 * SIGNALS_RESEARCH_PAGES_PER_RUN's default (settings.ts, README.md "Web research"; gamma-wr-045): the
 * pages one research run reads at most; at it the run ends `done` with `counts.budget_reached`.
 */
export const RESEARCH_PAGES_PER_RUN = { default: 40 } as const;

/** The pages of one host a run reads at most, the start pages' and the results' together. */
export const PAGES_PER_HOST = 3;
/** The pages a run lines up for reading, as a multiple of its limit: pages that fail do not use it. */
export const PAGES_QUEUE_FACTOR = 3;
/** The results of one search the pick may keep, the likeliest first. */
export const PICKS_PER_SEARCH = 5;
/** What the pick reads of a result, in characters: its title and its snippet. */
export const RESULT_TITLE_CHARS = 200;
export const RESULT_SNIPPET_CHARS = 500;
/** A result's address as the pick reads it, in characters. */
export const RESULT_URL_CHARS = 500;
/** The results one pick call reads at most: the search's own count, with room. */
export const PICK_RESULTS_MAX = 50;
/** A page whose text is shorter after the plain fetch is asked again of the browser. */
export const THIN_PAGE_CHARS = 200;
/** The whole read of one page, robots.txt included, in milliseconds. */
export const PAGE_TOTAL_MS = 60_000;
/** The robots.txt rules of this many runs are kept in a process, the oldest let go first. */
export const ROBOTS_RUNS_KEPT = 20;

/** What the pick and the pages add to the run's counts (README.md "Web research"). */
export const COUNT_RESULTS_DROPPED = "results_dropped";
export const COUNT_PAGES_PICKED = "pages_picked";
export const COUNT_PICKS_FAILED = "picks_failed";
export const COUNT_PAGES = "pages";
export const COUNT_PAGES_CLOSED = "pages_closed";
export const COUNT_PAGES_FAILED = "pages_failed";

/** The folders under the run's raw/ folder: each pick, the queue of pages, and each page read. */
export const PICK_FOLDER = "pick";
export const PAGES_FOLDER = "pages";
export const QUEUE_FILE = "queue.json";

// What the page reading and the candidates add (README.md "Web research"; gamma-wr-046).

/** The companies one page may name at most, and what the model reads of a page, in characters. */
export const PAGE_COMPANIES_MAX = 50;
export const PAGE_TEXT_INPUT_CHARS = 20_000;
export const PAGE_TITLE_INPUT_CHARS = 300;
/** The links of a page the model reads at most, and a link's characters. */
export const PAGE_LINKS_MAX = 100;
export const PAGE_LINK_CHARS = 200;
/** What the model writes of a company, in characters: its name, its place, the line and the quote. */
export const COMPANY_NAME_CHARS = 200;
export const COMPANY_PLACE_CHARS = 200;
export const COMPANY_LINE_CHARS = 300;
export const COMPANY_QUOTE_CHARS = 400;
/** A quote shorter than this is no evidence. */
export const QUOTE_MIN_CHARS = 8;

/** The gates the page's answer goes through, and the count each refusal adds (`refused_<gate>`). */
export const READ_GATES = [
  "name",
  "link",
  "place",
  "quote",
  "contact",
  "extra",
  "duplicate",
] as const;
export type ReadGate = (typeof READ_GATES)[number];
export const countRefused = (gate: ReadGate): string => `refused_${gate}`;

/** The count of a page that holds no company, a page the model could not read, and the candidates made. */
export const COUNT_PAGES_EMPTY = "pages_empty";
export const COUNT_READS_FAILED = "reads_failed";
export const COUNT_CANDIDATES = "candidates";
/** A company with no link whose site no search found, or that no search could be asked for. */
export const COUNT_CANDIDATES_NO_SITE = "candidates_no_site";
/** The candidates left by an earlier run and still waiting, counted at the run's candidate step. */
export const COUNT_CANDIDATES_CARRIED = "candidates_carried";
/** A company the source holds already: pending (known), or read or dropped within the re-check days. */
export const COUNT_CANDIDATES_KNOWN = "candidates_known";
export const COUNT_DROPPED_RECENT = "dropped_recent";
/** The results one search of a company's name asks for, and a day in milliseconds. */
export const NAME_SEARCH_RESULTS = 5;
export const DAY_MS = 86_400_000;

/** The drops, each a state `dropped` with this code and a count of its own: `dropped_<code>`. */
export const DROP_CODES = [
  "own_company",
  "never_contact",
  "customer",
  "competitor",
  "not_fit",
] as const;
export type DropCode = (typeof DROP_CODES)[number];
export const countDropped = (code: DropCode): string => `dropped_${code}`;

/** The folder of the companies each page named, under the run's raw/ folder. */
export const CANDIDATES_FOLDER = "candidates";

// What the company judge, the verdict and the found companies add (README.md "Web research"; gamma-wr-050).

/**
 * SIGNALS_RESEARCH_COMPANIES_PER_RUN's default (settings.ts, README.md "Web research"): the companies one
 * research run judges at most; at it the run ends `done` with `counts.budget_reached` and the candidates
 * left stay for the next run.
 */
export const RESEARCH_COMPANIES_PER_RUN = { default: 25 } as const;
/**
 * SIGNALS_RESEARCH_SITE_MAX_PAGES's default (settings.ts): the pages of one company's site the judge
 * reads at most, the home page included.
 */
export const RESEARCH_SITE_MAX_PAGES = { default: 5 } as const;
/** The candidates a run lines up for judging, as a multiple of its limit: a site not read does not use it. */
export const JUDGE_QUEUE_FACTOR = 3;
/** The pages of a site the model can be told of at most: the setting's value is cut to it. */
export const SITE_PAGES_MAX = 20;
/** What each page of a company's site gives the model, in characters, and all of them together. */
export const SITE_PAGE_TEXT_CHARS = 12_000;
export const SITE_PAGE_TITLE_CHARS = 300;
/** The characters of a company's pages the model reads in all. */
export const SITE_TEXT_TOTAL_CHARS = 50_000;

/** The must-haves and the disqualifiers the judge answers for at most, and an item's characters. */
export const CRITERIA_MAX = 10;
export const CRITERION_CHARS = 300;
/** The lists of the audience the judge is told, and what the model writes of a reason, in characters. */
export const REASON_LINE_CHARS = 300;
export const REASON_QUOTE_CHARS = 400;
/** What the model writes of where a company is and how it is reached, in characters. */
export const PLACE_WORD_CHARS = 120;
export const EMAIL_CHARS = 254;
export const PHONE_CHARS = 40;
export const PHONES_MAX = 5;
export const POSTAL_CHARS = 300;
/** A phone number the judge keeps holds this many digits at least, and at most this many. */
export const SITE_PHONE_DIGITS_MIN = 7;
export const SITE_PHONE_DIGITS_MAX = 15;
/** A quote about a place, in characters at least. */
export const PLACE_QUOTE_MIN_CHARS = 2;

/** The answers the judge gives each question, a closed list. */
export const ANSWERS = ["shown", "contradicted", "not_stated"] as const;
export type Answer = (typeof ANSWERS)[number];
/** The verdicts, decided by code. */
export const VERDICTS = ["fit", "not_fit", "unsure"] as const;
export type Verdict = (typeof VERDICTS)[number];
/** What a reason is about. */
export const REASON_KINDS = [
  "focus",
  "must_have",
  "disqualifier",
  "industry",
  "size",
  "country",
] as const;
export type ReasonKind = (typeof REASON_KINDS)[number];

/** The gates the judge's answer goes through, and the count of each refusal (`judge_refused_<gate>`). */
export const JUDGE_GATES = ["quote", "contact", "place", "email", "phone", "postal"] as const;
export type JudgeGate = (typeof JUDGE_GATES)[number];
export const countJudgeRefused = (gate: JudgeGate): string => `judge_refused_${gate}`;

/** What the judge adds to the run's counts. */
export const COUNT_COMPANIES_JUDGED = "companies_judged";
export const COUNT_COMPANIES_FIT = "companies_fit";
export const COUNT_COMPANIES_NOT_FIT = "companies_not_fit";
export const COUNT_COMPANIES_UNSURE = "companies_unsure";
export const COUNT_SITES_NOT_READ = "sites_not_read";
export const COUNT_JUDGES_FAILED = "judges_failed";
/** The count of a company's verdict. */
export const countVerdict = (verdict: Verdict): string => `companies_${verdict}`;

/** The folders under the run's raw/ folder: the judge's queue, each company's site and each verdict. */
export const JUDGE_FOLDER = "judge";
export const SITE_FOLDER = "site";
export const VERDICT_FOLDER = "verdict";
export const JUDGE_QUEUE_FILE = "queue.json";

/** The drop code of a candidate whose site could not be read, when the reader gives none. */
export const SITE_UNREADABLE = "site_unreadable";
/** The drop code of a candidate the model could not judge: its schema failed twice, or its call went over its budget. */
export const JUDGE_FAILED = "judge_failed";

// What the people on the pages add (README.md "Web research"; gamma-wr-060).

/**
 * SIGNALS_RESEARCH_PEOPLE_PER_COMPANY's default and its bounds (settings.ts): the people taken from one
 * found company at most, the best fits first. A privacy cap, not a product limit, so it keeps a
 * maximum.
 */
export const RESEARCH_PEOPLE_PER_COMPANY = { default: 3, min: 1, max: 10 } as const;
/** The people the read may answer for one company at most, and what it writes of each, in characters. */
export const PEOPLE_READ_MAX = 100;
export const PERSON_NAME_CHARS = 200;
export const PERSON_ROLE_CHARS = 200;
export const PERSON_PLACE_CHARS = 200;
export const PERSON_LINK_CHARS = 300;
export const PERSON_EMAIL_CHARS = 254;
/** A phone number as the page prints it, in characters (enrichment's form allows 40). */
export const PERSON_PHONE_CHARS = 40;
/** The roles the pick reads at most, a role's characters, and the audience's titles it is told. */
export const PEOPLE_PICK_MAX = 100;
export const PICK_ROLE_CHARS = 200;
/** The pages the people are read from at most: the company's site pages and the page that named it. */
export const PEOPLE_PAGES_MAX = SITE_PAGES_MAX + 1;
/** The links of one page the read keeps at most. */
export const PEOPLE_LINKS_MAX = 300;

/** The gates the read's answer goes through, and the count of each refusal (`people_refused_<gate>`). */
export const PEOPLE_GATES = [
  ...["page", "name", "role", "profile", "email", "place"],
  // A person's phone (gamma-wr-100): not a number by its form or not on the page; the found company's
  // own line; a number two of the people were given.
  ...["phone", "phone_company", "phone_shared"],
] as const;
export type PeopleGate = (typeof PEOPLE_GATES)[number];
export const countPeopleRefused = (gate: PeopleGate): string => `people_refused_${gate}`;

/** What the people step adds to the run's counts. */
export const COUNT_PEOPLE_COMPANIES = "people_companies";
export const COUNT_PEOPLE_READ = "people_read";
export const COUNT_PEOPLE_PICKED = "people_picked";
export const COUNT_PEOPLE_FOUND = "people_found";
export const COUNT_PEOPLE_KNOWN = "people_known";
export const COUNT_PEOPLE_NO_KEY = "people_no_key";
export const COUNT_PEOPLE_AMBIGUOUS = "people_ambiguous";
export const COUNT_PEOPLE_CONFLICT = "people_conflict";
export const COUNT_PEOPLE_ERASED = "people_erased";
export const COUNT_PEOPLE_NO_PAGES = "people_no_pages";
export const COUNT_PEOPLE_READS_FAILED = "people_reads_failed";
export const COUNT_PEOPLE_PICKS_FAILED = "people_picks_failed";
/** The email lookups asked for the new leads (gamma-wr-070). */
export const COUNT_PEOPLE_LOOKUPS = "people_lookups";
/** The profiles found by search for a picked person whose page printed no key (gamma-wr-070). */
export const COUNT_PEOPLE_PROFILES = "people_profiles";
/** The work addresses found for a picked person with no key, by their name and the company's domain (gamma-wr-080). */
export const COUNT_PEOPLE_ADDRESSES = "people_addresses";
/** The profile search's site, its results' count and the evidence's mark of a profile found by it. */
export const PROFILE_SITE = "linkedin.com";
export const PROFILE_RESULTS_COUNT = 10;
export const FOUND_BY_SEARCH = "search" as const;
/** The folder of the people step's profile searches' results under the run's raw/ folder. */
export const PROFILES_FOLDER = "profiles";
/** The phones of the people made: kept (new or held already), and not kept (held by another person, a never-contact person, an erased one). */
export const COUNT_PEOPLE_PHONES = "people_phones";
export const COUNT_PEOPLE_PHONES_NOT_KEPT = "people_phones_not_kept";

// What a company's managers by search add (README.md "Web research"; gamma-wr-090).

/** The results of the managers' search asked for: the port's most, and the evidence's mark of a person found by it. */
export const MANAGERS_RESULTS_COUNT = 10;
export const FOUND_BY_MANAGERS = "managers" as const;
/** The role words one query holds at most, the company's name cut to this many characters, and the query's own bound. */
export const MANAGERS_ROLE_WORDS_IN_QUERY = 4;
export const MANAGERS_NAME_CHARS = 100;
export const MANAGERS_QUERY_CHARS = 200;
/** The results one read holds at most, and what it reads of one, in characters. */
export const MANAGERS_RESULTS_MAX = 20;
export const MANAGERS_TITLE_CHARS = 200;
export const MANAGERS_SNIPPET_CHARS = 500;
/** The result's title the evidence keeps, in characters. */
export const MANAGERS_EVIDENCE_TITLE_CHARS = 300;
/** The number the page of a person found by search carries, the pages being numbered from 1. */
export const MANAGERS_PAGE = 0;
/** The folder of the managers' searches' results under the run's raw/ folder. */
export const MANAGERS_FOLDER = "managers";

/** The gates the read's answer goes through, and the count of each refusal (`managers_refused_<gate>`). */
export const MANAGERS_GATES = ["result", "name", "role"] as const;
export type ManagersGate = (typeof MANAGERS_GATES)[number];
export const countManagersRefused = (gate: ManagersGate): string => `managers_refused_${gate}`;
/** What the managers' search adds to the run's counts. */
export const COUNT_MANAGERS_SEARCHES = "managers_searches";
export const COUNT_MANAGERS_RESULTS = "managers_results";
export const COUNT_MANAGERS_PEOPLE = "managers_people";
export const COUNT_MANAGERS_READS_FAILED = "managers_reads_failed";

/** The folder of the people step's queue under the run's raw/ folder, and its file. */
export const PEOPLE_FOLDER = "people";
export const PEOPLE_QUEUE_FILE = "queue.json";

/** What a research event is: the event's one role in its dedupe key, and the source class of its person. */
export const PEOPLE_EVENT_ROLE = "found";
/** The key of the lookup asked for a new lead: `<this>:<personId>`, one for each person (gamma-wr-070). */
export const PEOPLE_LOOKUP_KEY = "research-found";
export const PEOPLE_STAMP = { source: "website", provider: "website" } as const;

// What the Companies found page, Not a fit and the CSV add (README.md "Web research"; gamma-wr-110).

/** A member's mark on a found company: Not a fit. The company is never read or judged again for its source. */
export const MEMBER_MARK_NOT_FIT = "not_fit";
/** The verdicts the list shows when no verdict is asked for: the companies still worth a look. */
export const LIST_DEFAULT_VERDICTS = ["fit", "unsure"] as const satisfies readonly Verdict[];
/** The list's page: the default and the most a request may ask for, and the CSV's page. */
export const FOUND_PAGE_DEFAULT = 25;
export const FOUND_PAGE_MAX = 100;
export const FOUND_CSV_PAGE = 100;
/** The leads a found company's row names at most (its people taken from the pages, gamma-wr-060). */
export const FOUND_LEADS_MAX = 10;
/** The panel on an agent's page shows this many of its newest fitting companies. */
export const FOUND_PANEL_COUNT = 5;
/** The candidate a run skips because a member marked its company Not a fit, counted on the run. */
export const COUNT_DROPPED_NOT_FIT = countDropped("not_fit");
/** What the plan is told of a source's Not a fit companies: how many, at most, the newest first. */
export const NOT_FIT_IN_INPUT_MAX = 100;
/** A name or a place the plan is told of a Not a fit company, in characters, and a domain's. */
export const NOT_FIT_NAME_CHARS = 120;
export const NOT_FIT_DOMAIN_CHARS = 253;
/** The file name of the CSV, before its date. */
export const FOUND_CSV_NAME = "companies-found";
