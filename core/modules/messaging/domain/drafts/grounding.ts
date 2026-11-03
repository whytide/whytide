// The drafts of the weekly grounding sample (README.md "Public interface"; @whytide/ai's README):
// each draft made in the week that holds the writer's text, with the facts of its lead's dossier as
// it is now, each with its sourceRef. The dossier is built without a sender, whom the draft does
// not keep, so a sender's name in a text is no fact here; a member's edit is not the writer's text
// and stays out, as does a sequence's connection note, empty and written by no one (beta-p3-010).
// Nothing here logs: the items hold the texts and the facts.
import { defineGroundingSource, type GroundingItem } from "@whytide/ai";
import { tenantClient, withTenant } from "@whytide/db";
import { servicePrincipal, type TenantContext } from "@whytide/platform";
import { buildDossier, givenClient } from "../dossier/build.ts";

const inRun = <T>(tenant: TenantContext, fn: () => Promise<T>) =>
  withTenant(tenant, fn, { client: givenClient() });

export const draftSample = defineGroundingSource({
  kind: "draft",
  async list(tenant, { from, to }) {
    const where = { createdAt: { gte: from, lt: to }, text: { not: null }, NOT: { text: "" } };
    const select = { id: true } as const;
    const rows = await inRun(tenant, () => tenantClient.messageDraft.findMany({ where, select }));
    return rows.map((row) => row.id);
  },
  async read(tenant, refs) {
    const where = { id: { in: [...refs] } };
    const select = { id: true, personId: true, text: true } as const;
    const drafts = await inRun(tenant, () => tenantClient.messageDraft.findMany({ where, select }));
    const reader = { workspaceId: tenant.workspaceId, principal: servicePrincipal("messaging") };
    const items: GroundingItem[] = [];
    for (const ref of refs) {
      const draft = drafts.find((row) => row.id === ref);
      if (!draft?.text) continue;
      const { facts } = await buildDossier(reader, draft.personId);
      const sourced = facts.map(({ value, sourceRef }) => ({ value, source: sourceRef }));
      items.push({ ref, text: draft.text, facts: sourced });
    }
    return items;
  },
});
