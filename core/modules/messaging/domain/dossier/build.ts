// buildDossier (README.md "The dossier"): the public reads of contacts, onboarding and signals in one
// run of the tenant's workspace, then tenancy's user outside any run (its reads of the global tables
// refuse to run inside one: core/packages/db README "One run at a time"), then the pure assembly.
// Nothing reads another module's tables.
import { errors as contactsErrors, getCompany, getLead } from "@whytide/contacts";
import { type PrismaClient, withTenant } from "@whytide/db";
import { readCompanyKnowledge } from "@whytide/onboarding";
import { AppError, isAppError, type TenantContext } from "@whytide/platform";
import { listEvidence } from "@whytide/signals";
import { findUser } from "@whytide/tenancy";
import { errors } from "../../errors.ts";
import type { Dossier } from "../../schemas/dossier.ts";
import { assembleDossier } from "./assemble.ts";

let given: PrismaClient | undefined;

/** For tests (testing/): the client the run opens on, `asRole("app")`; undefined is the process's. */
export function useClient(next: PrismaClient | undefined): void {
  given = next;
}

/** The client useClient gave, for the module's other runs (domain/drafts/grounding.ts). */
export const givenClient = (): PrismaClient | undefined => given;

/**
 * The dossier of the person's lead in the tenant's workspace, its sender the tenant's user;
 * dossier_lead_not_found when the workspace has no lead for the person. It opens its own run, so it
 * is called outside one.
 */
export async function buildDossier(tenant: TenantContext, personId: string): Promise<Dossier> {
  const read = await withTenant(tenant, () => readLead(tenant.workspaceId, personId), {
    client: given,
  });
  const { actorType, userId } = tenant.principal;
  const sender = actorType === "human" ? await findUser(userId) : null;
  return assembleDossier({ ...read, sender });
}

async function readLead(workspaceId: string, personId: string) {
  const { person } = await getLead(personId).catch((error: unknown) => {
    if (isAppError(error) && error.code === contactsErrors.lead_not_found) {
      throw new AppError(errors.dossier_lead_not_found);
    }
    throw error;
  });
  const company = person.companyId === null ? null : await getCompany(person.companyId);
  const knowledge = await readCompanyKnowledge(workspaceId);
  const events = await listEvidence(person.id);
  return { person, company, knowledge, events };
}
