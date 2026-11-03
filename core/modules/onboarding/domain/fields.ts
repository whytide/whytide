// The Company Knowledge record's fields, limits and types (README "The record"). Constants only, no
// import: the PUT body's schema, the rules and the screen read the same limits.

/** The limits, in characters and items: the texts and lists reach the writer's prompt as data. */
export const LIMITS = {
  oneLiner: 200,
  longDescription: 2000,
  tone: 500,
  /** Items per list: products, pain points, features and benefits, proof points, competitors. */
  items: 20,
  /** A product, a pain point, a feature or benefit, a competitor. */
  item: 200,
  /** A proof point's text. */
  proofPoint: 500,
  url: 2048,
} as const;

/** Where a Draft's run stands: fetching, fetched while the drafter reads, drafted, or failed. */
export const FETCH_STATUSES = ["none", "fetching", "fetched", "drafted", "failed"] as const;
export type FetchStatus = (typeof FETCH_STATUSES)[number];

/** The fields a person or a draft writes, each with its source in `fieldSources`. */
export const CONTENT_FIELDS = [
  "oneLiner",
  "longDescription",
  "products",
  "painPoints",
  "featuresBenefits",
  "proofPoints",
  "competitors",
  "tone",
] as const;
export type ContentField = (typeof CONTENT_FIELDS)[number];

/** A fact the writer may cite: a customer, a metric, a testimonial, with the page it came from. */
export type ProofPoint = { readonly text: string; readonly sourceUrl?: string };

/** Who wrote a field last: a draft from a page (alpha-p4-030) or a person, and when (ISO 8601). */
export type FieldSource = {
  readonly kind: "ai_draft" | "human";
  readonly at: string;
  readonly sourceUrl?: string;
};
export type FieldSources = { readonly [F in ContentField]?: FieldSource };

/** The content fields, as stored. */
export type Content = {
  readonly oneLiner: string;
  readonly longDescription: string;
  readonly products: string[];
  readonly painPoints: string[];
  readonly featuresBenefits: string[];
  readonly proofPoints: ProofPoint[];
  readonly competitors: string[];
  readonly tone: string;
};

/** What saveCompanyKnowledge takes, as the PUT body carries it: the website and every content field. */
export type CompanyKnowledgeFields = Content & { readonly sourceUrl: string | null };
