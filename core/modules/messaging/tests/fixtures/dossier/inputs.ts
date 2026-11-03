// A lead's reads as buildDossier gets them (domain/dossier/assemble.ts, DossierInputs), synthetic:
// the sender, Company Knowledge, a person linked to a company, and two events listed oldest first,
// the older one's evidence reduced (alpha-p10-020), so its words are gone.
import type { DossierInputs } from "../../../domain/dossier/assemble.ts";

const post = (n: number) =>
  `https://www.linkedin.com/feed/update/urn:li:activity:725000000000000000${n}`;

export const inputs: DossierInputs = {
  sender: { id: "usr_01SENDER", displayName: "Sam Writer" },
  knowledge: {
    id: "ck_01FIXTURE",
    oneLiner: "Warm B2B leads from buying signals.",
    products: ["Signal Radar", "Lead Review"],
    painPoints: ["Leads go cold before sales calls them."],
    proofPoints: [
      { text: "Northwind booked 40% more meetings in a quarter." },
      { text: "Used by 120 sales teams." },
    ],
  },
  person: {
    id: "per_01FIXTURE",
    firstName: "Ines",
    headline: "Head of Data",
    title: "Head of Data",
    locationText: "Lisbon, Portugal",
    companyName: "Acme",
  },
  company: {
    id: "wco_01FIXTURE",
    name: "Acme",
    industry: "Software Development",
    sizeRange: "51-200",
    country: "PT",
  },
  events: [
    {
      id: "sev_01OLDER",
      occurredAt: new Date("2026-10-01T09:00:00.000Z"),
      evidence: {
        id: "evd_01OLDER",
        url: post(1),
        excerpt: null,
        commentText: null,
        reaction: "like",
      },
    },
    {
      id: "sev_02NEWER",
      occurredAt: new Date("2026-10-02T09:00:00.000Z"),
      evidence: {
        id: "evd_02NEWER",
        url: post(2),
        excerpt: "Exactly our problem.",
        commentText: "Exactly our problem. We lose leads every week.",
        reaction: "comment",
      },
    },
  ],
};
