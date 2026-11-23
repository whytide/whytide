// What the database tests share: the agent task loaded from the sources as a host loads it, the LLM
// fake, the fixture person with a company and an ICP seeded through contacts' and icp's commands,
// more persons of that profile and more audiences (gamma-p5-050), a valid answer of the model, and
// assessPerson's context: tenant runs and callAgent's options as the app role.
import { loadAgentTasks } from "@whytide/ai";
import { linkPersonToCompany, upsertCompany, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { readIcpForScoring } from "@whytide/icp";
import { newId, servicePrincipal } from "@whytide/platform";
import { getAdapter, type LlmFake, llmPort } from "@whytide/providers";
import type { AssessContext } from "../../domain/assess/assess-person.ts";
import type { AssessFitOutput } from "../../schemas/assess-fit.ts";

useHashSalt("test-salt-".repeat(4));
await loadAgentTasks([new URL("../../agents/assess-fit/task.ts", import.meta.url).href]);
export const fake = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
const prices = {
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
};
const principal = servicePrincipal("qualification_test");

/** One tenant run in the workspace, as the app role. */
export const run = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });

/** assessPerson's context in the workspace: an activity's tenant runs, callAgent as the app role. */
export const contextOf = (workspaceId: string): AssessContext => ({
  workspaceId,
  tenant: (fn) => run(workspaceId, fn),
  call: { client: asRole("app"), prices },
});

/** The fixture person: names, pronouns, gender, an age, a city and a photo link in the texts. */
export const PERSON = {
  linkedinUrl: "https://linkedin.com/in/adaeze-quill-feather",
  firstName: "Adaeze",
  lastName: "Quill-Feather",
  headline:
    "Adaeze Quill-Feather (she/her) | Chairwoman and Head of Revenue Operations | https://media.example.com/adaeze.jpg",
  title: "Head of Revenue Operations, 41 years old",
  locationText: "Berlin, Germany",
};
export const COMPANY = {
  name: "Blue Harbor Labs",
  domain: "blueharbor.example",
  industry: "Software",
  sizeRange: "51-200",
};
export const ICP = {
  titles: ["Head of Revenue Operations", "VP Sales"],
  seniorities: ["head", "vp"],
  industries: ["Software"],
  sizeRanges: ["51-200", "201-500"],
  countries: ["DE", "AT"],
  mustHaves: "Runs a sales team on a CRM",
  disqualifiers: "Agencies and freelancers",
};

/**
 * Seeds the person, the company and the ICP in the workspace and returns the person's id. The ICP's
 * fields are written as they are, at version 1: icp's own save moves the version.
 */
export async function seed(workspaceId: string, icp: Partial<typeof ICP> = {}): Promise<string> {
  return run(workspaceId, async (tx) => {
    const profile = PERSON;
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    const company = COMPANY;
    const { company: stored } = await upsertCompany({ source: "import", provider: "csv", company });
    await linkPersonToCompany({ personId: person.id, companyId: stored.id });
    const { id } = (await readIcpForScoring(workspaceId)).icp;
    await tx.icp.update({ where: { id }, data: { ...ICP, ...icp } });
    return person.id;
  });
}

/**
 * Another person of the fixture's profile in the workspace, at its own LinkedIn URL, linked to the
 * fixture company; `profile` changes its fields. Its id.
 */
export async function seedPerson(
  workspaceId: string,
  slug: string,
  profile: Partial<typeof PERSON> = {},
): Promise<string> {
  return run(workspaceId, async () => {
    const linkedinUrl = `https://linkedin.com/in/${slug}`;
    const fields = { ...PERSON, linkedinUrl, ...profile };
    const imported = { source: "import", provider: "csv" } as const;
    const { person } = await upsertPersonFromSource({ ...imported, profile: fields });
    const { company } = await upsertCompany({ ...imported, company: COMPANY });
    await linkPersonToCompany({ personId: person.id, companyId: company.id });
    return person.id;
  });
}

/**
 * Another audience of the workspace (gamma-p5-050), not the default, at version 1, with the fixture
 * ICP's fields changed by `icp` and the default's criteria, their weights changed by `weights`. Its
 * id. The default is made first, as icp's first read makes it.
 */
export async function addAudience(
  workspaceId: string,
  name: string,
  icp: Partial<typeof ICP> = {},
  weights: Readonly<Record<string, number>> = {},
): Promise<string> {
  return run(workspaceId, async (tx) => {
    const { criteria } = await readIcpForScoring(workspaceId);
    const id = newId("icp");
    await tx.icp.create({ data: { id, workspaceId, name, isDefault: false, ...ICP, ...icp } });
    const rows = criteria.map(({ key, weight, isMust, enabled }) => ({
      ...{ id: newId("crit"), workspaceId, icpId: id, key },
      ...{ weight: weights[key] ?? weight, isMust, enabled },
    }));
    await tx.criterion.createMany({ data: rows });
    return id;
  });
}

/** A valid answer for the fixture person, each verdict quoting its data; `must_haves` unknown. */
export function answer(change: Partial<AssessFitOutput> = {}): AssessFitOutput {
  return {
    verdicts: [
      { criterion: "title_function", verdict: "met", evidence: "Head of Revenue Operations" },
      { criterion: "seniority", verdict: "met", evidence: "Head of Revenue Operations" },
      { criterion: "company_size", verdict: "met", evidence: "51-200" },
      { criterion: "industry", verdict: "met", evidence: "Software" },
      { criterion: "location", verdict: "met", evidence: "Germany (DE)" },
      { criterion: "must_haves", verdict: "unknown", evidence: "" },
    ],
    disqualifiers: [],
    summary: "A revenue operations head at a mid-sized software company in Germany.",
    ...change,
  };
}
