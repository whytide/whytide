// The rules of the Company Knowledge record (docs/concepts.md): what a save stores, the URL rule,
// which fields a save changed and the source each one then carries, the company's domain. Plain
// TypeScript, unit-tested in tests/domain.test.ts. The lengths and counts are the PUT body's schema
// (schemas/company-knowledge.ts), from the limits of fields.ts. And what an accept of a draft writes.
import { AppError } from "@whytide/platform";
import { errors } from "../errors.ts";
import type { DraftOutput } from "../schemas/draft-company-knowledge.ts";
import { documentName } from "./documents.ts";
import {
  CONTENT_FIELDS,
  type CompanyKnowledgeFields,
  type ContentField,
  type FieldSource,
  type FieldSources,
  type ProofPoint,
} from "./fields.ts";

/** Whether `value` is an absolute http or https URL with a host and no user name or password. */
export function isWebUrl(value: string): boolean {
  const url = URL.parse(value);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) return false;
  return url.hostname !== "" && url.username === "" && url.password === "";
}

/**
 * What a save stores: texts trimmed, list items trimmed, non-empty and each once (a proof point by
 * its text), an empty website or page none. A website that is not an http or https URL, or a proof
 * point's page that is neither that nor a document's source (`document:<name>`, README "The
 * documents"), is company_knowledge_invalid_url, `details.fields` naming each by its path in the body.
 */
export function normalize(fields: CompanyKnowledgeFields): CompanyKnowledgeFields {
  const site = fields.sourceUrl?.trim() || null;
  const pages = fields.proofPoints.map((point) => point.sourceUrl?.trim() || undefined);
  const cited = (page: string) => isWebUrl(page) || documentName(page) !== null;
  const invalid = [
    ...(site === null || isWebUrl(site) ? [] : ["sourceUrl"]),
    ...pages.flatMap((page, at) =>
      page === undefined || cited(page) ? [] : [`proofPoints.${at}.sourceUrl`],
    ),
  ];
  if (invalid.length > 0) {
    throw new AppError(errors.company_knowledge_invalid_url, { details: { fields: invalid } });
  }
  const points = fields.proofPoints.map(
    (point, at): ProofPoint => withPage(point.text.trim(), pages[at]),
  );
  return {
    sourceUrl: site,
    oneLiner: fields.oneLiner.trim(),
    longDescription: fields.longDescription.trim(),
    products: distinct(fields.products),
    painPoints: distinct(fields.painPoints),
    featuresBenefits: distinct(fields.featuresBenefits),
    proofPoints: points.filter(
      (point, at) => point.text !== "" && points.findIndex((p) => p.text === point.text) === at,
    ),
    competitors: distinct(fields.competitors),
    tone: fields.tone.trim(),
  };
}

/** The content fields whose value differs between `stored` and `next`; a list's order counts. */
export function changedFields(
  stored: CompanyKnowledgeFields,
  next: CompanyKnowledgeFields,
): ContentField[] {
  return CONTENT_FIELDS.filter((field) => comparable(stored, field) !== comparable(next, field));
}

/** The sources after a write: each field of `fields` gets `mark`, the others keep theirs. */
export function markFields(
  sources: FieldSources,
  fields: readonly ContentField[],
  mark: FieldSource,
): FieldSources {
  const next: { [F in ContentField]?: FieldSource } = { ...sources };
  for (const field of fields) next[field] = mark;
  return next;
}

/** What an accept writes: the fields and their sources after it, and the fields it changed. */
export type Accepted = {
  readonly fields: CompanyKnowledgeFields;
  readonly fieldSources: FieldSources;
  readonly changed: ContentField[];
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const TEXT_FIELDS = ["oneLiner", "longDescription", "tone"] as const;
const LIST_FIELDS = ["products", "painPoints", "featuresBenefits", "competitors"] as const;

/**
 * What an accept writes (README "The drafter"): each field the draft holds, a text or a list with an
 * item, over the record's, but a field a person wrote last (`human`) only with `replaceEdited`; the
 * values as a save stores them, a proof point with its page. Each field that then changed is marked
 * `ai_draft` with its value's page, a list with its first item's; the others keep their source.
 */
export function applyDraft(
  stored: CompanyKnowledgeFields & { readonly fieldSources: FieldSources },
  draft: DraftOutput,
  options: { readonly replaceEdited: boolean; readonly at: string },
): Accepted {
  const open = (field: ContentField) =>
    options.replaceEdited || stored.fieldSources[field]?.kind !== "human";
  const next: Mutable<CompanyKnowledgeFields> = { ...stored };
  const pages: { [F in ContentField]?: string } = {};
  for (const field of TEXT_FIELDS) {
    const item = draft[field];
    if (item === null || item.text.trim() === "" || !open(field)) continue;
    next[field] = item.text;
    pages[field] = item.sourceUrl;
  }
  for (const field of LIST_FIELDS) {
    const [first] = draft[field];
    if (first === undefined || !open(field)) continue;
    next[field] = draft[field].map((item) => item.text);
    pages[field] = first.sourceUrl;
  }
  const [point] = draft.proofPoints;
  if (point !== undefined && open("proofPoints")) {
    next.proofPoints = draft.proofPoints.map(({ text, sourceUrl }) => ({ text, sourceUrl }));
    pages.proofPoints = point.sourceUrl;
  }
  const fields = normalize(next);
  const changed = changedFields(stored, fields).filter((field) => pages[field] !== undefined);
  let fieldSources = stored.fieldSources;
  for (const field of changed) {
    const mark = { kind: "ai_draft", at: options.at, sourceUrl: pages[field] } as const;
    fieldSources = markFields(fieldSources, [field], mark);
  }
  return { fields, fieldSources, changed };
}

/** The company's domain: the host of its website without a leading `www.`; null without one. */
export function domainOf(sourceUrl: string | null): string | null {
  const host = sourceUrl === null ? "" : (URL.parse(sourceUrl)?.hostname ?? "");
  return host.replace(/^www\./, "") || null;
}

function withPage(text: string, page: string | undefined): ProofPoint {
  return page === undefined ? { text } : { text, sourceUrl: page };
}

function distinct(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter((item) => item !== ""))];
}

/** A field's value as one string, the proof points as pairs, so that key order never counts. */
function comparable(fields: CompanyKnowledgeFields, field: ContentField): string {
  if (field !== "proofPoints") return JSON.stringify(fields[field]);
  return JSON.stringify(fields.proofPoints.map((point) => [point.text, point.sourceUrl ?? ""]));
}
