// The e2e api's routes for the draft review (core/apps/web/tests/draft-review.spec.ts), test only: the
// e2e api runs no worker, so POST /test/onboarding/draft/<drafted|failed|documented> writes the record
// of the review's own workspace as the drafter leaves it; `documented` is a draft with values from a
// document the script was given (knowledge-draft). And the documents' card's
// (onboarding-documents.spec.ts, onboarding-setup): POST /test/onboarding/documents/<empty|drafted>
// removes its workspace's record, or drafts its latest Draft from the documents it was given. And the
// prompt at sign-in's (onboarding-get-started.spec.ts): POST /test/onboarding/get-started/<state>
// writes its workspace's record and ICP as the workers leave them at each step. The workspace is
// this file's, never the request's.
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

/** The documents' card's own workspace: no other spec writes its record. */
export const DOCUMENTS_WORKSPACE = "wsp_e2e_documents";
const DOCUMENT_STATES = ["empty", "drafted"] as const;
const document = (text: string, name: string) => ({
  text,
  sourceUrl: `document:${name}`,
  quote: text,
});
const FROM_DOCUMENTS = {
  ...{ oneLiner: document("Corvid Freight", "deck.pdf"), longDescription: null, tone: null },
  ...{ products: [document("Same-day parcels", "deck.pdf")], painPoints: [], competitors: [] },
  featuresBenefits: [document("Sunday deliveries", "faq.md")],
  proofPoints: [document("Trusted by 300 shops in the city.", "deck.pdf")],
};

/**
 * The handler of POST /test/onboarding/documents/<empty|drafted>: the documents' workspace's record
 * and documents removed, so that its next read makes it empty; or its latest Draft drafted from its
 * documents, as the drafter writes it, the run kept.
 */
export function seedDocumentsRoute() {
  let db: PrismaClient | undefined;
  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    const state = DOCUMENT_STATES.find((name) => req.url === `/test/onboarding/documents/${name}`);
    if (req.method !== "POST" || state === undefined) return next();
    db ??= createDbClient("app");
    const client = db;
    const where = { workspaceId: DOCUMENTS_WORKSPACE };
    const pendingDraft = { model: "fake-model", promptVersion: 2, decisionRecordId: "dec_e2e_doc" };
    const fields = FROM_DOCUMENTS;
    const data = {
      fetchStatus: "drafted",
      fetchedAt: new Date(),
      pendingDraft: { ...pendingDraft, fields },
    };
    const written =
      state === "empty"
        ? client.companyDocument
            .deleteMany({ where })
            .then(() => client.websitePage.deleteMany({ where }))
            .then(() => client.companyKnowledge.deleteMany({ where }))
        : client.companyKnowledge.updateMany({ where, data });
    written.then(() => res.writeHead(204).end()).catch(next);
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

/** The prompt at sign-in's own workspace: no other spec writes its record or its ICP. */
export const GET_STARTED_WORKSPACE = "wsp_e2e_get_started";
const GET_STARTED_STATES = ["empty", "fetched", "failed", "saved", "icp-drafting", "icp-saved"];
const NO_TARGETING = {
  ...{ titles: [], seniorities: [], industries: [], sizeRanges: [], countries: [] },
  ...{ mustHaves: "", disqualifiers: "" },
};
const ICP_DRAFT_ENDED = { draftStatus: "none", draftError: null, draftRunId: null };

/**
 * The record or the ICP of the prompt's workspace in `state`: `empty`, the record removed, so that
 * its next read makes it empty, and the ICP without targeting or draft; `fetched`, the run's pages
 * read; `failed`, the fetch refused (a name that does not resolve); `saved`, the draft accepted by
 * the run itself, as recordDraft leaves it; `icp-drafting`, icp's automatic draft started by its
 * subscriber; `icp-saved`, that draft saved into the empty ICP.
 */
function writeGetStarted(client: PrismaClient, state: string): Promise<unknown> {
  const where = { workspaceId: GET_STARTED_WORKSPACE };
  const at = new Date();
  const ai = { kind: "ai_draft", at: at.toISOString(), sourceUrl: SITE };
  const knowledge = (data: Prisma.CompanyKnowledgeUpdateManyMutationInput) =>
    client.companyKnowledge.updateMany({ where, data });
  const icp = (data: Prisma.IcpUpdateManyMutationInput) => client.icp.updateMany({ where, data });
  if (state === "fetched") return knowledge({ fetchStatus: "fetched", fetchedAt: at });
  if (state === "failed")
    return knowledge({ fetchStatus: "failed", fetchError: "egress_dns_failed" });
  if (state === "saved") {
    return knowledge({
      ...{ fetchStatus: "drafted", oneLiner: "Corvid moves parcels for small shops." },
      ...{ products: ["Same-day parcels", "Bike couriers"], competitors: ["Swift Couriers"] },
      fieldSources: { oneLiner: ai, products: ai, competitors: ai },
      ...{ version: 2, pendingDraft: Prisma.DbNull },
    });
  }
  if (state === "icp-drafting") {
    return icp({
      draftStatus: "drafting",
      draftRunId: "idrun_e2e_get_started",
      draftAutomatic: true,
    });
  }
  if (state === "icp-saved") {
    const targeting = { titles: ["Shop owner", "Operations manager"], industries: ["Retail"] };
    return icp({ ...targeting, countries: ["DE", "FR"], version: 2, ...ICP_DRAFT_ENDED });
  }
  return client.websitePage
    .deleteMany({ where })
    .then(() => client.companyDocument.deleteMany({ where }))
    .then(() => client.companyKnowledge.deleteMany({ where }))
    .then(() => icp({ ...NO_TARGETING, ...ICP_DRAFT_ENDED, draftAutomatic: false }));
}

/** The handler of POST /test/onboarding/get-started/<state>, mounted ahead of the routes. */
export function seedGetStartedRoute() {
  let db: PrismaClient | undefined;
  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    const state = GET_STARTED_STATES.find(
      (name) => req.url === `/test/onboarding/get-started/${name}`,
    );
    if (req.method !== "POST" || state === undefined) return next();
    db ??= createDbClient("app");
    writeGetStarted(db, state)
      .then(() => res.writeHead(204).end())
      .catch(next);
  };
}
