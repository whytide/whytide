// What the website source makes of a site's pages, in code (README "The website source"): the
// company's LinkedIn page from the pages' links, the pages cut for the AI, the fields wanted asked in
// the reader's words, and the reader's answer as the run's facts. Pure.
import type {
  ReadCompanySiteInput,
  ReadCompanySiteOutput,
  SiteField,
} from "../../../schemas/read-company-site.ts";
import type { CompanyField, Field } from "../../constants.ts";
import type { SourceFacts } from "../define.ts";
import {
  AI_FIELDS,
  FACTS_OF,
  INPUT_BYTES,
  INPUT_CHARS,
  LINKEDIN_HOST,
  LINKEDIN_PAGE,
  LINKEDIN_SLUG,
} from "./constants.ts";

type Page = { readonly url: string; readonly title: string; readonly text: string };
type Linked = { readonly links: readonly { readonly href: string }[] };

/**
 * The first link of the pages to a company's LinkedIn page, as `https://www.linkedin.com/company/
 * <slug>`; a person's `/in/` page, or any other, is never one.
 */
export function linkedinPageOf(pages: readonly Linked[]): string | undefined {
  for (const { links } of pages) {
    for (const { href } of links) {
      const url = URL.parse(href);
      if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) continue;
      if (!LINKEDIN_HOST.test(url.hostname.toLowerCase()) || url.port !== "") continue;
      const [, section, slug] = url.pathname.split("/");
      if (section?.toLowerCase() === "company" && slug !== undefined && LINKEDIN_SLUG.test(slug)) {
        return `${LINKEDIN_PAGE}${slug.toLowerCase()}`;
      }
    }
  }
  return undefined;
}

/** The reader's words for the run's fields it reads; none for a page or a domain. */
export function aiFieldsOf(wanted: readonly Field[]): SiteField[] {
  return wanted.flatMap((field) => {
    const word = AI_FIELDS[field as CompanyField];
    return word === undefined ? [] : [word];
  });
}

/**
 * The pages for the AI, in their order: their texts INPUT_CHARS characters and INPUT_BYTES bytes in
 * all, as the blocks write them (JSON, `<` as `&lt;`), the last one cut and the rest left out.
 */
export function cutPages(pages: readonly Page[]): ReadCompanySiteInput["pages"] {
  let chars = INPUT_CHARS;
  let bytes = INPUT_BYTES;
  const cut: ReadCompanySiteInput["pages"] = [];
  for (const { url, title, text } of pages) {
    let at = 0;
    for (const char of text) {
      const cost = costOf(char);
      if (char.length > chars || cost > bytes) break;
      chars -= char.length;
      bytes -= cost;
      at += char.length;
    }
    if (at === 0 && text !== "") break;
    cut.push({ url, title, text: text.slice(0, at) });
  }
  return cut;
}

/** A character's bytes in a block: its UTF-8 in a JSON string, `<` written `&lt;`. */
function costOf(char: string): number {
  if (char === "<") return 4;
  return Buffer.byteLength(JSON.stringify(char)) - 2;
}

/** The reader's answer as the run's facts: the wanted ones only, a size as contacts takes it. */
export function factsOf(output: ReadCompanySiteOutput, wanted: readonly SiteField[]): SourceFacts {
  const asked = new Set(wanted.flatMap((field) => FACTS_OF[field]));
  const given = (fact: keyof ReadCompanySiteOutput) => asked.has(fact) && output[fact] !== null;
  const range = given("employeeRange") ? output.employeeRange?.value : undefined;
  const facts = {
    industry: given("industry") ? output.industry?.value.trim() : undefined,
    description: given("description") ? output.description?.value.trim() : undefined,
    country: given("country") ? output.country?.value : undefined,
    employeeCount: given("employeeCount") ? output.employeeCount?.value : undefined,
    sizeRange: range && (range.to === null ? `${range.from}+` : `${range.from}-${range.to}`),
  };
  return Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined));
}
