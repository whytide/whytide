// The source `website` (README "The website source"; gamma-en-065): a company with a domain has a
// few of its own pages read (site.ts). robots.txt allowing no page records `blocked`, with no AI call;
// a site that cannot be read records the reader's code. The LinkedIn page comes from the pages'
// links, in code. While a wanted field other than the page is still empty, the agent task
// enrichment.read-company-site reads the pages for those fields, each value with its page and a
// quote of it; an answer that fails twice throws enrichment_site_ai_failed, so the step records
// `failed` and writes nothing. A country is kept only when contacts knows its code. The agent gets the
// company's name, the fields and its pages, nothing of the person, through callAgent with the
// company as its subject: a cost event and a decision record, no credits.
import { callAgent, registeredAgentTasks } from "@whytide/ai";
import { countryCode } from "@whytide/contacts";
import { AppError, SITE_CODES } from "@whytide/platform";
import type { readCompanySiteTask } from "../../../agents/read-company-site/task.ts";
import { errors } from "../../../errors.ts";
import { READ_COMPANY_SITE } from "../../../schemas/read-company-site.ts";
import { agentCallOptions } from "../agent-call.ts";
import {
  defineSource,
  type SourceAnswer,
  type SourceContext,
  type SourceFacts,
  type SourceInput,
} from "../define.ts";
import { BLOCKED, TIMEOUT_SECONDS, WEBSITE } from "./constants.ts";
import { aiFieldsOf, cutPages, factsOf, linkedinPageOf } from "./facts.ts";
import { readCompanySite } from "./site.ts";

async function run(input: SourceInput, context: SourceContext): Promise<SourceAnswer> {
  const { workspaceId, companyId, company = {}, wanted } = input;
  // A domain is a company's: without its id, no subject for the agent's records.
  if (company.domain === undefined || companyId === null) return { found: false };
  const read = await readCompanySite(company.domain, () => context.beat?.());
  if (!read.ok) {
    return { found: false, outcome: read.code === SITE_CODES.disallowed ? BLOCKED : read.code };
  }
  const page = wanted.includes("linkedinUrl") ? linkedinPageOf(read.pages) : undefined;
  let facts: SourceFacts = page === undefined ? {} : { linkedinUrl: page };
  const asked = aiFieldsOf(wanted);
  const pages = cutPages(read.pages);
  if (asked.length > 0 && pages.length > 0) {
    const call = { company: company.name ?? "", wanted: asked, pages };
    const ask = { workspaceId, subjectRef: companyId, input: call };
    const result = await callAgent(registeredTask(), ask, agentCallOptions());
    if (result.status !== "ok") throw new AppError(errors.enrichment_site_ai_failed);
    const { country, ...rest } = factsOf(result.output, asked);
    const known = country === undefined ? null : countryCode(country);
    facts = { ...facts, ...rest, ...(known !== null && { country: known }) };
  }
  return Object.keys(facts).length > 0 ? { found: true, facts } : { found: false };
}

/** The task the host registered at start (loadAgentTasks); never imported here (agents/). */
function registeredTask(): typeof readCompanySiteTask {
  const task = registeredAgentTasks().get(READ_COMPANY_SITE);
  if (task === undefined) throw new AppError(errors.enrichment_site_agent_not_loaded);
  return task as unknown as typeof readCompanySiteTask;
}

export const websiteSource = defineSource({
  name: WEBSITE,
  kind: "company",
  fills: ["linkedinUrl", "industry", "sizeRange", "country", "description"],
  needs: ["domain"],
  activityKind: "ai",
  timeoutSeconds: TIMEOUT_SECONDS,
  provenance: { source: "website", provider: WEBSITE },
  run,
});
