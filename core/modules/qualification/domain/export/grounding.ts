// The why bullets of the weekly grounding sample (README.md "Public interface"; @whytide/ai's
// README): each bullet that quotes the model, fit or must_missed, of a lead whose current snapshot
// was made in the week, worded in English, with what the model read of the person: the assessment
// input's profile, company and evidence from the decision record's raw prompt, or, after its
// raw_purge_after, rebuilt from the person and the company as they are now, without evidence. A ref
// is `<snapshotId>:<the bullet's index>`; a fact's source is the record and the input's field.
// Nothing here logs: the items hold the profile's words.
import {
  defineGroundingSource,
  type GroundingFact,
  type GroundingItem,
  rawPrompts,
} from "@whytide/ai";
import { getCompany, getLead, type Person } from "@whytide/contacts";
import { tenantClient, withTenant } from "@whytide/db";
import {
  createTranslator,
  loadMessages,
  type TenantContext,
  type Translator,
} from "@whytide/platform";
import type { AssessFitInput } from "../../schemas/assess-fit.ts";
import { anonymizeForAssessment } from "../anonymize/index.ts";
import { givenClient } from "../client.ts";
import { inputOfPrompt } from "./golden-line.ts";

/** The bullets that quote the model's evidence; the others hold codes and counts. */
const QUOTING = new Set(["qualification.why.fit", "qualification.why.must_missed"]);
const PAGE = 100;
let english: Translator | undefined;

const inRun = <T>(tenant: TenantContext, fn: () => Promise<T>) =>
  withTenant(tenant, fn, { client: givenClient() });

export const whySample = defineGroundingSource({
  kind: "why",
  async list(tenant, { from, to }) {
    const where = { createdAt: { gte: from, lt: to } };
    const select = { id: true, personId: true } as const;
    const made = await inRun(tenant, () => tenantClient.scoreSnapshot.findMany({ where, select }));
    const refs: string[] = [];
    for (let at = 0; at < made.length; at += PAGE) {
      refs.push(...(await inRun(tenant, () => quotingRefs(made.slice(at, at + PAGE)))));
    }
    return refs;
  },
  read: (tenant, refs) => inRun(tenant, () => itemsOf(refs)),
});

/** The refs of the quoting bullets of each snapshot its lead points at, in the caller's run. */
async function quotingRefs(snapshots: readonly { id: string; personId: string }[]) {
  const refs: string[] = [];
  for (const { id, personId } of snapshots) {
    const lead = await getLead(personId);
    if (lead.currentScoreSnapshotId !== id) continue;
    for (const [index, { key }] of lead.why.entries()) {
      if (QUOTING.has(key)) refs.push(`${id}:${index}`);
    }
  }
  return refs;
}

async function itemsOf(refs: readonly string[]): Promise<GroundingItem[]> {
  english ??= createTranslator(loadMessages("en"), "en");
  const t = english;
  const parsed = refs.map((ref) => {
    const [id = "", index = ""] = ref.split(":");
    return { ref, id, index: Number(index) };
  });
  const snapshots = await tenantClient.scoreSnapshot.findMany({
    where: { id: { in: parsed.map(({ id }) => id) } },
    select: { id: true, personId: true, decisionRecordId: true },
  });
  const prompts = await rawPrompts(snapshots.map((snapshot) => snapshot.decisionRecordId));
  const items: GroundingItem[] = [];
  for (const { ref, id, index } of parsed) {
    const snapshot = snapshots.find((row) => row.id === id);
    if (snapshot === undefined) continue;
    const lead = await getLead(snapshot.personId);
    const bullet = lead.currentScoreSnapshotId === id ? lead.why[index] : undefined;
    if (bullet === undefined || !QUOTING.has(bullet.key)) continue;
    const prompt = prompts.get(snapshot.decisionRecordId) ?? null;
    const kept = prompt === null ? null : inputOfPrompt(prompt);
    const record = `decision_records/${snapshot.decisionRecordId}`;
    const facts = kept === null ? await rebuilt(lead.person) : factsOf(kept, () => record);
    items.push({ ref, text: t(bullet.key, bullet.params), facts });
  }
  return items;
}

/** After the raw purge: the profile and the company as they are now, no evidence. */
async function rebuilt(person: Person): Promise<GroundingFact[]> {
  const { companyId } = person;
  const company = companyId === null ? null : await getCompany(companyId);
  const recordOf = (field: string) =>
    field.startsWith("company.") ? `workspace_companies/${companyId}` : `persons/${person.id}`;
  return factsOf(anonymizeForAssessment(person, company), recordOf);
}

/** The input's texts about the person, each with the record it was read from and its field. */
function factsOf(
  input: Pick<AssessFitInput, "profile" | "company" | "evidence">,
  recordOf: (field: string) => string,
): GroundingFact[] {
  const fields = [
    ...Object.entries(input.profile).map(([name, value]) => [`profile.${name}`, value] as const),
    ...Object.entries(input.company).map(([name, value]) => [`company.${name}`, value] as const),
    ...input.evidence.map((value, index) => [`evidence.${index}`, value] as const),
  ];
  return fields.flatMap(([field, value]) =>
    value === null ? [] : [{ value, source: `${recordOf(field)}#${field}` }],
  );
}
