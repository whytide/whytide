// The e2e api's route for the draft review (core/apps/web/tests/draft-review.spec.ts), test only: the
// e2e api runs no worker, so POST /test/onboarding/draft/<drafted|failed|documented> writes the record
// of the review's own workspace as the drafter leaves it; `documented` is a draft with values from a
// document the script was given (knowledge-draft). The workspace is this file's, never the request's.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDbClient, Prisma, type PrismaClient } from "@whytide/db";

/** The draft review's own workspace, the e2e users': no other spec writes its record. */
export const DRAFT_WORKSPACE = "wsp_e2e_c";
const OUTCOMES = ["drafted", "failed", "documented"] as const;
const SITE = "https://corvid.test/";
const cite = (text: string, path: string) => ({ text, sourceUrl: `${SITE}${path}`, quote: text });
const FIELDS = {
  oneLiner: cite("Corvid moves parcels for small shops.", ""),
  longDescription: cite("Corvid carries the parcels of small shops across town by bike.", "about"),
  products: [cite("Same-day parcels", ""), cite("Bike couriers", "about")],
  painPoints: [],
  featuresBenefits: [],
  proofPoints: [cite("Trusted by 300 shops", "customers")],
  competitors: [],
  tone: null,
};
const DECK = "document:deck.pdf";
const FROM_DOCUMENT = {
  ...FIELDS,
  products: [cite("Same-day parcels", ""), { ...cite("Cargo bikes", ""), sourceUrl: DECK }],
  proofPoints: [{ ...cite("Trusted by 300 shops", ""), sourceUrl: DECK }],
};

/** The record as a person left it before the Draft, a website and a one-liner of their own, drafted. */
function record(outcome: (typeof OUTCOMES)[number]) {
  const at = new Date().toISOString();
  const pendingDraft = { model: "fake-model", promptVersion: 1, decisionRecordId: "dec_e2e_c" };
  return {
    sourceUrl: SITE,
    fetchStatus: outcome === "failed" ? "failed" : "drafted",
    fetchedAt: new Date(),
    fetchError: outcome === "failed" ? "ai_failed" : null,
    draftRunId: "drun_e2e_c",
    ...{ oneLiner: "Parcels for small shops, by bike", longDescription: "", tone: "" },
    ...{ products: [], painPoints: [], featuresBenefits: [], proofPoints: [], competitors: [] },
    fieldSources: { oneLiner: { kind: "human", at } },
    version: 2,
    pendingDraft:
      outcome === "failed"
        ? Prisma.DbNull
        : { ...pendingDraft, fields: outcome === "drafted" ? FIELDS : FROM_DOCUMENT },
  };
}

/** The handler of POST /test/onboarding/draft/<outcome>, which the e2e api mounts ahead of the routes. */
export function seedDraftRoute() {
  let db: PrismaClient | undefined;
  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    const outcome = OUTCOMES.find((name) => req.url === `/test/onboarding/draft/${name}`);
    if (req.method !== "POST" || outcome === undefined) return next();
    db ??= createDbClient("app");
    const data = record(outcome);
    const where = { workspaceId: DRAFT_WORKSPACE };
    db.companyKnowledge
      .upsert({ where, create: { ...data, ...where, id: "ck_e2e_c" }, update: data })
      .then(() => res.writeHead(204).end())
      .catch(next);
  };
}
