// The dossier from what the reads answered (README.md "The dossier", docs/concepts.md), in pure
// code: the five blocks, every value once in facts[] with its id and its source, the entities and
// the hash. The ids follow the order the blocks list their values in, so the same inputs give the
// same ids and the same hash.
import { type Dossier, dossierSchema, type Fact, type FactKind } from "../../schemas/dossier.ts";
import { entitiesOf } from "./entities.ts";
import { hashOf } from "./hash.ts";

/** What buildDossier reads (build.ts), narrowed to the stored business fields the dossier uses. */
export type DossierInputs = {
  /** tenancy's user; null for a service principal. */
  readonly sender: { readonly id: string; readonly displayName: string | null } | null;
  /** onboarding's Company Knowledge record. */
  readonly knowledge: {
    readonly id: string;
    readonly oneLiner: string;
    readonly products: readonly string[];
    readonly painPoints: readonly string[];
    readonly proofPoints: readonly { readonly text: string }[];
  };
  /** contacts' person of the lead. */
  readonly person: {
    readonly id: string;
    readonly firstName: string | null;
    readonly headline: string | null;
    readonly title: string | null;
    readonly locationText: string | null;
    readonly companyName: string | null;
  };
  /** contacts' company the person is linked to, or null. */
  readonly company: {
    readonly id: string;
    readonly name: string;
    readonly industry: string | null;
    readonly sizeRange: string | null;
    readonly country: string | null;
  } | null;
  /** signals' events of the person, each with its evidence or null, in any order. */
  readonly events: readonly {
    readonly id: string;
    readonly occurredAt: Date;
    readonly evidence: {
      readonly id: string;
      readonly url: string;
      readonly excerpt: string | null;
      readonly commentText: string | null;
      readonly reaction: string;
    } | null;
  }[];
};
type Event = DossierInputs["events"][number];

const regions = new Intl.DisplayNames(["en"], { type: "region" });

/** The dossier of the inputs, checked against its strict schema. */
export function assembleDossier(inputs: DossierInputs): Dossier {
  const facts: Fact[] = [];
  /** The trimmed value, listed as the next fact; null for none, which is no fact. */
  const fact = (kind: FactKind, raw: string | null, sourceRef: string): string | null => {
    const value = raw?.trim();
    if (!value) return null;
    facts.push({ id: `f_${facts.length + 1}`, kind, value, sourceRef });
    return value;
  };
  const items = (kind: FactKind, values: readonly string[], ref: string): string[] =>
    values.flatMap((raw, index) => fact(kind, raw, `${ref}/${index}`) ?? []);

  const { sender, knowledge, person, company } = inputs;
  const ck = `company_knowledge/${knowledge.id}`;
  const per = `persons/${person.id}`;
  const wco = company && `workspace_companies/${company.id}`;
  const blocks = {
    sender: { name: sender && fact("name", sender.displayName, `users/${sender.id}/display_name`) },
    offer: {
      oneLiner: fact("quote", knowledge.oneLiner, `${ck}/one_liner`),
      products: items("tool", knowledge.products, `${ck}/products`),
      painPoints: items("quote", knowledge.painPoints, `${ck}/pain_points`),
      proofPoints: knowledge.proofPoints.flatMap(
        ({ text }, index) => fact("claim", text, `${ck}/proof_points/${index}/text`) ?? [],
      ),
    },
    lead: {
      firstName: fact("name", person.firstName, `${per}/first_name`),
      headline: fact("title", person.headline, `${per}/headline`),
      title: fact("title", person.title, `${per}/title`),
      location: fact("name", person.locationText, `${per}/location_text`),
    },
    // Without a linked company, the employer the person's profile names.
    company:
      company === null
        ? {
            name: fact("company", person.companyName, `${per}/company_name`),
            industry: null,
            sizeRange: null,
            country: null,
          }
        : {
            name: fact("company", company.name, `${wco}/name`),
            industry: fact("company", company.industry, `${wco}/industry`),
            sizeRange: fact("number", company.sizeRange, `${wco}/size_range`),
            country: fact("name", countryName(company.country), `${wco}/country`),
          },
    whyNow: newestFirst(inputs.events).flatMap(({ id, occurredAt, evidence }) => {
      // An event without evidence has nothing to cite; neither has one without its post.
      if (evidence === null || !evidence.url.trim() || !evidence.reaction.trim()) return [];
      const evd = `evidence/${evidence.id}`;
      return [
        {
          postUrl: fact("event", evidence.url, `${evd}/url`) as string,
          excerpt: fact("quote", evidence.excerpt, `${evd}/excerpt`),
          comment: fact("quote", evidence.commentText, `${evd}/comment_text`),
          reaction: fact("event", evidence.reaction, `${evd}/reaction`) as string,
          at: fact("date", occurredAt.toISOString(), `signal_events/${id}/occurred_at`) as string,
        },
      ];
    }),
  };
  const body = { ...blocks, facts, entities: entitiesOf(facts) };
  return dossierSchema.parse({ ...body, dossierHash: hashOf(body) });
}

/** The newest first, ties by the event's id, descending, as signals' evidence route lists them. */
function newestFirst(events: readonly Event[]): Event[] {
  return [...events].sort(
    (a, b) =>
      b.occurredAt.getTime() - a.occurredAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

/** The English name of an ISO 3166-1 alpha-2 code, as the writer and the gate read it; else the code. */
function countryName(code: string | null): string | null {
  if (code === null) return null;
  try {
    return regions.of(code.trim()) ?? code;
  } catch {
    return code;
  }
}
