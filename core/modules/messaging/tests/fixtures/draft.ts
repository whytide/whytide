// What tests/draft.test.ts and tests/tenancy.test.ts share: the two agent tasks loaded from the
// sources as a host loads them, the LLM fake, a workspace with a Member and the fixture lead (its
// company, Company Knowledge and one comment event) written through contacts', onboarding's table
// and signals' factory, a `drafting` draft, and writeDraft's context: an activity's tenant runs and
// callAgent's options as the app role. The lead's fact ids are fixed: FACTS names them.
import { loadAgentTasks } from "@whytide/ai";
import {
  createLeadForPerson,
  linkPersonToCompany,
  upsertCompany,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { getAdapter, type LlmFake, llmPort } from "@whytide/providers";
import { createSignalEvent } from "@whytide/signals/testing";
import {
  createMembership,
  createOrganizationWithWorkspace,
  createUser,
} from "@whytide/tenancy/testing";
import { createDraft } from "../../domain/drafts/store.ts";
import type { DraftContext } from "../../domain/drafts/write.ts";
import type { Channel, PlanOutput } from "../../schemas/writer.ts";

useHashSalt("test-salt-".repeat(4));
const agents = new URL("../../agents/", import.meta.url);
await loadAgentTasks(
  ["plan-message", "write-message"].map((agent) => new URL(`${agent}/task.ts`, agents).href),
);
export const fake = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
const prices = {
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
};
const principal = servicePrincipal("messaging_test");

/** One tenant run in the workspace, as the app role. */
export const run = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });

/** writeDraft's context in the workspace: an activity's tenant runs, callAgent as the app role. */
export const contextOf = (workspaceId: string): DraftContext => ({
  workspaceId,
  tenant: (fn) => run(workspaceId, fn),
  call: { client: asRole("app"), prices },
});

/** The fixture lead's facts by id, in the dossier's order: f_1 is the sender's name. */
export const FACTS = {
  oneLiner: "f_2",
  product: "f_3",
  painPoint: "f_5",
  proofPoint: "f_6",
  firstName: "f_7",
  company: "f_11",
  excerpt: "f_16",
  comment: "f_17",
} as const;
export const COMMENT = "Exactly our problem. We lose leads every week.";

/** A workspace with a Member, and its lead; the comment is the event's, COMMENT unless given. */
export async function seed(comment: string = COMMENT) {
  const { workspace } = await createOrganizationWithWorkspace();
  const user = await createUser();
  await createMembership({ userId: user.id, workspaceId: workspace.id, role: "Member" });
  const workspaceId = workspace.id;
  const personId = await run(workspaceId, async (tx) => {
    const profile = {
      linkedinUrl: "https://linkedin.com/in/ines-duarte",
      firstName: "Ines",
      lastName: "Duarte",
      headline: "Head of Data at Acme",
      title: "Head of Data",
      locationText: "Lisbon, Portugal",
    };
    const { person } = await upsertPersonFromSource({
      source: "linkedin",
      provider: null,
      profile,
    });
    const { company } = await upsertCompany({
      source: "linkedin",
      provider: null,
      company: {
        name: "Acme",
        linkedinUrl: "https://linkedin.com/company/acme",
        industry: "Software Development",
        sizeRange: "51-200",
        country: "PT",
      },
    });
    await linkPersonToCompany({ personId: person.id, companyId: company.id });
    await createLeadForPerson({ personId: person.id, source: { kind: "signal", ref: "sev_1" } });
    const knowledge = {
      oneLiner: "Warm B2B leads from buying signals.",
      products: ["Signal Radar", "Lead Review"],
      painPoints: ["Leads go cold before sales calls them."],
      proofPoints: [{ text: "Northwind booked 40% more meetings in a quarter." }],
    };
    await tx.companyKnowledge.create({ data: { ...knowledge, id: newId("ck"), workspaceId } });
    return person.id;
  });
  const occurredAt = new Date("2026-10-02T09:00:00.000Z");
  await createSignalEvent({ workspaceId, personId, occurredAt, commentText: comment });
  return { workspaceId, personId, userId: user.id };
}

/** A `drafting` draft of the person, as POST …/drafts leaves it. */
export async function draftOf(workspaceId: string, personId: string, channel: Channel) {
  return (await run(workspaceId, () => createDraft({ personId, channel }))).id;
}

/** The draft as stored, the columns the tests read. */
export type StoredDraft = {
  readonly status: string;
  readonly plan: unknown;
  readonly text: string | null;
  readonly modelId: string | null;
  readonly promptVersion: number | null;
  readonly decisionRecordId: string | null;
  readonly dossierHash: string | null;
  readonly gates: unknown;
  readonly regenerations: number;
  readonly flagReasons: unknown;
};
export const stored = (workspaceId: string, id: string): Promise<StoredDraft> =>
  run(workspaceId, (tx) => tx.messageDraft.findFirstOrThrow({ where: { id } }));

/** A plan on the lead's comment, citing its first name, the comment and the product. */
export const PLAN: PlanOutput = {
  angle: "signal_comment",
  factIds: [FACTS.firstName, FACTS.comment, FACTS.product],
  cta: "question",
};
/** A message of 189 characters that names only the lead's facts. */
export const GROUNDED =
  "Ines, your comment that you lose leads every week stood out. Signal Radar flags buying signals so Acme can reach warm leads before they go cold. How does your team follow up on leads today?";

/** A grounded text of exactly `length` characters. */
export const sized = (length: number) =>
  `${"Ines, how does your team follow up on warm leads".padEnd(length - 1, " so")}?`;
