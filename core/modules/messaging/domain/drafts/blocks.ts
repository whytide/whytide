// The writer's data blocks from the dossier (schemas/writer.ts; security §6): every value with its
// fact id and nothing else, so no source, record id or hash reaches the model; the lead with their
// company, and why now, in their own blocks, which the prompts mark untrusted; why now the newest
// three events, without the post's link (README.md "Decided here"). Pure.
import type { Dossier, Fact } from "../../schemas/dossier.ts";
import type { PlanInput } from "../../schemas/writer.ts";

export type WriterBlocks = Pick<PlanInput, "dossier" | "lead" | "why_now">;
type Cited = Record<string, string>;

/** The events the writer reads, the newest first. */
export const WHY_NOW_EVENTS = 3;

export function writerBlocks(dossier: Dossier): WriterBlocks {
  const { sender, offer, lead, company, whyNow } = dossier;
  const cite = citer(dossier.facts);
  // In the facts' order (domain/dossier/assemble.ts): an object literal runs its members in order.
  const read = {
    sender: { name: cite(sender.name) },
    offer: {
      oneLiner: cite(offer.oneLiner),
      products: cite(offer.products),
      painPoints: cite(offer.painPoints),
      proofPoints: cite(offer.proofPoints),
    },
    lead: {
      firstName: cite(lead.firstName),
      headline: cite(lead.headline),
      title: cite(lead.title),
      location: cite(lead.location),
    },
    company: {
      name: cite(company.name),
      industry: cite(company.industry),
      sizeRange: cite(company.sizeRange),
      country: cite(company.country),
    },
    whyNow: whyNow.map((event) => ({
      postUrl: cite(event.postUrl),
      excerpt: cite(event.excerpt),
      comment: cite(event.comment),
      reaction: cite(event.reaction),
      at: cite(event.at),
    })),
  };
  return {
    dossier: { sender: read.sender, offer: read.offer },
    lead: { ...read.lead, company: read.company },
    why_now: read.whyNow
      .slice(0, WHY_NOW_EVENTS)
      .map(({ reaction, at, excerpt, comment }) => ({ reaction, at, excerpt, comment })),
  };
}

/** Each value takes the next fact, which holds it: `{ "f_3": "Signal Radar" }`; none for null. */
function citer(facts: readonly Fact[]) {
  let next = 0;
  return (value: string | null | readonly string[]): Cited => {
    const values = value === null ? [] : typeof value === "string" ? [value] : value;
    const cited: Cited = {};
    for (const item of values) {
      const fact = facts[next++];
      // assembleDossier lists the facts so: anything else is a bug there, not data.
      if (fact?.value !== item) throw new Error("the dossier's facts are out of its blocks' order");
      cited[fact.id] = item;
    }
    return cited;
  };
}
