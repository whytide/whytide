// The ICP's closed lists, its limits and its six criteria with their default weights (README "The
// record", docs/concepts.md). The labels of the lists are message keys, icp.seniority.* and
// icp.size.*, read through ui/labels.ts. Plain TypeScript: the api and the worker use the same lists.

/** Seniorities, highest first (F02 §4). */
export const SENIORITIES = [
  "owner_founder",
  "c_level",
  "vp",
  "head",
  "director",
  "manager",
  "senior_ic",
  "ic",
] as const;
export type Seniority = (typeof SENIORITIES)[number];

/** Company sizes, in employees, smallest first; the last one is over 5,000. */
export const SIZE_RANGES = [
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001-5000",
  "5001+",
] as const;
export type SizeRange = (typeof SIZE_RANGES)[number];

/** ISO 3166-1 alpha-2: the 249 codes officially assigned, in order. */
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

/** The six criteria, in the order the screen and the scorer list them. */
export const CRITERION_KEYS = [
  "title_function",
  "seniority",
  "company_size",
  "industry",
  "location",
  "must_haves",
] as const;
export type CriterionKey = (typeof CRITERION_KEYS)[number];

/** A criterion as an ICP holds it: its weight in the fit score, whether it is a must, whether it counts. */
export type Criterion = {
  readonly key: CriterionKey;
  readonly weight: number;
  readonly isMust: boolean;
  readonly enabled: boolean;
};

/** A new ICP's criteria: F04 §4.3's weights, summing to 100, and title/function and location as musts. */
export const DEFAULT_CRITERIA: readonly Criterion[] = [
  { key: "title_function", weight: 30, isMust: true, enabled: true },
  { key: "seniority", weight: 15, isMust: false, enabled: true },
  { key: "company_size", weight: 10, isMust: false, enabled: true },
  { key: "industry", weight: 15, isMust: false, enabled: true },
  { key: "location", weight: 10, isMust: true, enabled: true },
  { key: "must_haves", weight: 20, isMust: false, enabled: true },
];

/**
 * The record's limits, in items and characters: the criteria text is data for the model, kept short
 * so the prompt stays bounded (docs/rules/security.md §6). `brief`: the admin's brief a draft reads.
 */
export const LIMITS = {
  name: 100,
  titles: 50,
  industries: 30,
  item: 100,
  text: 1000,
  brief: 2000,
} as const;

/** Where the latest draft of the ICP stands (README "The draft"); it never moves the version. */
export const DRAFT_STATUSES = ["none", "drafting", "drafted", "failed"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/** A failed draft's codes beside the registered ones: every agent's, and its attempts spent. */
export const DRAFT_RUN_CODES = { aiFailed: "ai_failed", draftFailed: "draft_failed" } as const;
