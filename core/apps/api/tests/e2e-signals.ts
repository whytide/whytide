// The e2e api's part for the sources screen (core/apps/web/tests/sources-screen.spec.ts), test only:
// two sender accounts of the fixture workspace that nobody signs in as, one connected and one
// disconnected, so that the spec never shares the e2e user's own account, which
// linkedin-connect.spec.ts disconnects and connects again; and POST /test/signals/runs
// `{ sourceId, runs }`, which seeds a source's runs through signals' factory, as no public route
// writes runs, and sets the source's last_run_at to its newest start, as a run's start does
// (gamma-p5-040), and a run's research plan when it names one (gamma-wr-041). The spec names the accounts by their labels. Two more of them, and the runs, in
// RUN_NOW_WORKSPACE (signals-run-now.spec.ts); STATES_WORKSPACE (signals-states.spec.ts) gets none.
// For the lead page's evidence panel (core/apps/web/tests/evidence-panel.spec.ts),
// POST /test/signals/evidence `{ leads }` (below). For the Companies found screen and the agent's panel
// (core/apps/web/tests/signals-found-companies.spec.ts), POST /test/signals/found `{ sourceId,
// companies, reset? }` (below).
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { createDbClient, type PrismaClient, withTenant } from "@whytide/db";
import { servicePrincipal } from "@whytide/platform";

// signals' factory by its build's path, as src/modules.generated.ts loads the module: the api does
// not list a module with a screen (core/apps/web/docs/screens.md).
type SignalsTesting = typeof import("../../../modules/signals/dist/testing/index.js");
const testing: SignalsTesting = await import(
  new URL("../../../../modules/signals/dist/testing/index.js", import.meta.url).href
);
const {
  createFoundCompany,
  createResearchPlan,
  createSignalEvent,
  createSignalRun,
  createSignalSource,
} = testing;

/** The workspaces of signals' screen states and of Run now, which no other spec writes to. */
export const STATES_WORKSPACE = "wsp_e2e_signals";
export const RUN_NOW_WORKSPACE = "wsp_e2e_run_now";
const SENDERS = [
  { label: "Sources e2e, connected", status: "connected" },
  { label: "Sources e2e, disconnected", status: "disconnected" },
] as const;
const RUNS_PATH = "/test/signals/runs";

/**
 * Writes the two accounts, or sets them back to their state; their ids count from `first`. The
 * connected one is `owner`'s, a user of the e2e's, where a spec needs an account of its user's own.
 */
export async function seedSenders(
  db: PrismaClient,
  workspaceId: string,
  first = 1,
  owner?: string,
): Promise<void> {
  for (const [index, { label, status }] of SENDERS.entries()) {
    const id = `sac_01K8E2E${String(first + index).padStart(19, "0")}`;
    const account = {
      label,
      status,
      provider: "fake",
      timeZone: "Europe/Paris",
      workingHours: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] },
    };
    const ownerUserId = status === "connected" && owner ? owner : `usr_e2e_${status}`;
    const keys = { id, workspaceId, ownerUserId };
    const acknowledged = { disclosureAcknowledgedAt: new Date() };
    await db.senderAccount.upsert({
      where: { id },
      create: { ...keys, ...account, ...acknowledged },
      update: account,
    });
  }
}

type SeededRun = {
  status?: "scheduled" | "running" | "waiting" | "done" | "failed" | "cancelled";
  startedAt?: string;
  finishedAt?: string;
  counts?: Record<string, number>;
  error?: string;
  /** The run's research plan (gamma-wr-041): the card of a Web research source shows the last. */
  plan?: { words: { language: string; words: string[] }[]; placeIds: string[] };
};

/**
 * The handler of POST /test/signals/runs, which the e2e api mounts ahead of the routes: the runs of a
 * source of one of these workspaces, else 404.
 */
export function seedRunsRoute(...workspaceIds: string[]) {
  let db: PrismaClient | undefined;
  const date = (at: string | undefined) => (at === undefined ? null : new Date(at));
  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    if (req.method !== "POST" || req.url !== RUNS_PATH) return next();
    db ??= createDbClient("app");
    const client = db;
    readJson(req)
      .then(async ({ sourceId, runs }: { sourceId: string; runs: SeededRun[] }) => {
        const source = await client.signalSource.findUnique({ where: { id: sourceId } });
        if (source === null || !workspaceIds.includes(source.workspaceId)) {
          res.statusCode = 404;
          return void res.end();
        }
        const { workspaceId } = source;
        let lastRunAt = source.lastRunAt;
        for (const run of runs) {
          const times = { startedAt: date(run.startedAt), finishedAt: date(run.finishedAt) };
          const { plan, ...row } = run;
          const made = await createSignalRun({ ...row, ...times, workspaceId, sourceId }, client);
          if (plan)
            await createResearchPlan({ ...plan, workspaceId, sourceId, runId: made.id }, client);
          const { startedAt } = times;
          if (startedAt !== null && (lastRunAt === null || startedAt > lastRunAt)) {
            lastRunAt = startedAt;
          }
        }
        if (lastRunAt !== source.lastRunAt) {
          await client.signalSource.update({ where: { id: sourceId }, data: { lastRunAt } });
        }
        res.statusCode = 204;
        res.end();
      })
      .catch(next);
  };
}

/** The evidence panel's workspace, which no other spec writes to. */
export const EVIDENCE_WORKSPACE = "wsp_e2e_evidence";
const EVIDENCE_PATH = "/test/signals/evidence";

type SeededLead = {
  slug: string;
  firstName: string;
  lastName: string;
  /** The lead's sources in order: `imported`, or the label of a signal source. */
  sources: string[];
  events: {
    source: string;
    reaction?: "like" | "comment" | "repost";
    commentText?: string;
    author?: string;
    occurredAt: string;
    /** Reduced as alpha-p10-020 leaves it: no excerpt or comment. */
    reduced?: boolean;
    /** A Web research event (gamma-wr-061): the page the person was found on and the company's reasons. */
    research?: {
      page: string;
      company: string;
      domain: string;
      reasons: object[];
      /** The person's profile was found by a web search (gamma-wr-070), or the person by the managers' search (gamma-wr-090). */
      foundBy?: string;
      /** The title of the managers' search's result (gamma-wr-090). */
      title?: string;
    };
  }[];
};

/**
 * The handler of POST /test/signals/evidence `{ leads }`: the workspace's sources, events and leads
 * replaced with these, each person and lead written by contacts' commands, each source, event and
 * its evidence by signals' factories; answers `{ personIds }`, in the leads' order.
 */
export function seedEvidenceRoute(workspaceId: string) {
  let db: PrismaClient | undefined;
  const tenant = { workspaceId, principal: servicePrincipal("e2e_signals") };
  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    if (req.method !== "POST" || req.url !== EVIDENCE_PATH) return next();
    db ??= createDbClient("app");
    const client = db;
    readJson(req)
      .then(async ({ leads }: { leads: SeededLead[] }) => {
        const where = { workspaceId };
        await client.signalEvent.deleteMany({ where });
        await client.signalFoundCompany.deleteMany({ where });
        await client.signalSource.deleteMany({ where });
        await client.lead.deleteMany({ where });
        const labels = new Set(
          leads.flatMap((lead) => lead.sources.filter((s) => s !== "imported")),
        );
        const sourceIds = new Map<string, string>();
        for (const label of labels) {
          sourceIds.set(label, (await createSignalSource({ workspaceId, label }, client)).id);
        }
        const personIds: string[] = [];
        for (const { slug, firstName, lastName, sources, events } of leads) {
          const writeLead = async () => {
            const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName, lastName };
            const { person } = await upsertPersonFromSource({
              source: "linkedin",
              provider: null,
              profile,
            });
            for (const label of sources) {
              const ref = sourceIds.get(label) ?? "e2e";
              const kind = label === "imported" ? "imported" : "signal";
              await createLeadForPerson({ personId: person.id, source: { kind, ref } });
            }
            return person.id;
          };
          const personId = await withTenant(tenant, writeLead, { client });
          for (const { source, occurredAt, reduced, research, ...event } of events) {
            const at = new Date(occurredAt);
            const reducedAt = reduced ? new Date() : undefined;
            const sourceId = sourceIds.get(source);
            const input = { ...event, workspaceId, personId, sourceId, occurredAt: at, reducedAt };
            if (research === undefined) {
              await createSignalEvent(input, client);
              continue;
            }
            const { page: url, company: name, domain, reasons, foundBy, title } = research;
            const found = { workspaceId, sourceId: sourceId ?? "e2e", domain, name, reasons };
            const { id: foundCompanyId } = await createFoundCompany(found, client);
            await createSignalEvent(
              {
                ...input,
                ...{ url, ...(title === undefined ? {} : { ownWords: title }) },
                research: { foundCompanyId, ...(foundBy === undefined ? {} : { foundBy }) },
              },
              client,
            );
          }
          personIds.push(personId);
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ personIds }));
      })
      .catch(next);
  };
}

/** The Companies found screen's workspace, which no other spec writes to. */
export const FOUND_WORKSPACE = "wsp_e2e_found";
const FOUND_PATH = "/test/signals/found";

type SeededCompany = {
  domain: string;
  name: string;
  verdict: "fit" | "not_fit" | "unsure";
  judgedAt: string;
  reasons?: object[];
  country?: string;
  town?: string;
  state?: string;
  placeId?: string;
  pageUrl?: string;
  email?: string;
  phones?: string[];
  postalAddress?: string;
};

/**
 * The handler of POST /test/signals/found `{ sourceId, companies, reset? }`, which the e2e api mounts
 * ahead of the routes: the found companies of a source of one of these workspaces, written by
 * signals' factory as no public route writes them (the worker's judge does), after the workspace's
 * own are removed when `reset` is true; else 404 for a source of another workspace.
 */
export function seedFoundRoute(...workspaceIds: string[]) {
  let db: PrismaClient | undefined;
  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    if (req.method !== "POST" || req.url !== FOUND_PATH) return next();
    db ??= createDbClient("app");
    const client = db;
    readJson(req)
      .then(async ({ sourceId, companies, reset }: Body) => {
        const source = await client.signalSource.findUnique({ where: { id: sourceId } });
        if (source === null || !workspaceIds.includes(source.workspaceId)) {
          res.statusCode = 404;
          return void res.end();
        }
        const { workspaceId } = source;
        if (reset) await client.signalFoundCompany.deleteMany({ where: { workspaceId } });
        const ids: string[] = [];
        for (const { judgedAt, ...company } of companies) {
          const input = { ...company, workspaceId, sourceId, sourceLabel: source.label };
          const made = await createFoundCompany({ ...input, judgedAt: new Date(judgedAt) }, client);
          ids.push(made.id);
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ids }));
      })
      .catch(next);
  };
}
type Body = { sourceId: string; companies: SeededCompany[]; reset?: boolean };

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
