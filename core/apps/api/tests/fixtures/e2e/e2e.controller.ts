// The e2e module's routes (index.ts), for the web's end-to-end tests only (lead-list.spec.ts,
// lead-page.spec.ts, review-panel.spec.ts, messaging-draft-panel.spec.ts,
// credits-screen.spec.ts):
// - POST …/e2e/leads replaces the workspace's leads, and their review decisions, with the ones the
//   body lists, each person and lead written by contacts' own commands, as an import or a signal
//   (the sources the body gives) and qualification write them, and a lead's snapshot, if any, with
//   its verdicts, as qualification stores and scores one (it has no command that writes one
//   without the model);
// - POST …/e2e/spend spends credits as a batch does, through credits' reserve and commit, after the
//   organization's grant for the period, which the worker (absent here) gives a new organization;
//   with a `key`, once for that key;
// - POST …/e2e/drafts replaces a person's message drafts with the ones the body lists, oldest first,
//   and POST …/e2e/drafts/{id} writes a `drafting` one as its writer leaves it, in the worker's
//   stead: both through messaging's factory (its @whytide/messaging/testing);
// - POST …/e2e/costs replaces the workspace's cost events with the ones the body lists, as callAgent
//   records them, created now.
import { randomUUID } from "node:crypto";
import { Body, Controller, HttpCode, Module, Param, Post } from "@nestjs/common";
import { applyQualification, createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { type Prisma, tenantClient } from "@whytide/db";
import {
  credits,
  currentTenant,
  definePermissions,
  definePrices,
  newId,
  platformIds,
} from "@whytide/platform";
import { z } from "zod";
import { ApiRoute } from "../../../openapi/route.ts";
import { Permission } from "../../../src/permission.ts";

// messaging's factory by its build's path, as src/modules.generated.ts loads the module: the api
// lists no module with a screen (core/apps/web/docs/screens.md).
type MessagingTesting = typeof import("../../../../../modules/messaging/dist/testing/index.js");
type SeededDraft = Parameters<MessagingTesting["writeMessageDraft"]>[1];
const { createMessageDraft, writeMessageDraft }: MessagingTesting = await import(
  new URL("../../../../../../modules/messaging/dist/testing/index.js", import.meta.url).href
);

export const permissions = definePermissions(
  [{ action: "e2e.write", roles: ["Owner", "Admin", "Member"] }],
  import.meta.url,
);
const prices = definePrices([{ action: "e2e.batch", credits: 5, unit: "lead" }], import.meta.url);

const lead = z.strictObject({
  slug: z.string().regex(/^[a-z0-9-]{1,60}$/),
  firstName: z.string().max(80).optional(),
  lastName: z.string().max(80).optional(),
  headline: z.string().max(200).optional(),
  title: z.string().max(120).optional(),
  companyName: z.string().max(120).optional(),
  locationText: z.string().max(120).optional(),
  source: z.enum(["imported", "signal"]),
  /**
   * createLeadForPerson's sources, in this order, which contacts checks, `at` an ISO time; none
   * gives the lead one of `source`'s kind, ref `e2e`.
   */
  sources: z
    .array(z.looseObject({ at: z.iso.datetime().optional() }))
    .max(5)
    .optional(),
  /** applyQualification's input without the person, which contacts checks; none leaves it pending. */
  decision: z.record(z.string(), z.unknown()).optional(),
  /** The score_snapshots row and its criterion_verdicts, which the lead's decision points at. */
  snapshot: z
    .strictObject({
      status: z.enum(["qualified", "not_qualified", "needs_review"]),
      fitScore: z.int().min(0).max(100),
      confidence: z.enum(["high", "medium", "low"]),
      tier: z.enum(["hot", "warm", "cool"]),
      icpVersion: z.int().min(1),
      summary: z.string().max(300),
      disqualifiers: z.array(z.string()).max(11),
      verdicts: z
        .array(
          z.strictObject({
            criterion: z.string(),
            verdict: z.string(),
            evidence: z.string().max(300),
            weight: z.int().min(0).max(100),
            points: z.number().min(0).max(1),
          }),
        )
        .max(6),
    })
    .optional(),
});
const leadsBody = z.strictObject({ leads: z.array(lead).max(100) });
type LeadsBody = z.infer<typeof leadsBody>;
type Decision = Parameters<typeof applyQualification>[0];
type LeadSource = Parameters<typeof createLeadForPerson>[0]["source"];
type Entry = Record<string, unknown> & { at?: string };
type Snapshot = NonNullable<LeadsBody["leads"][number]["snapshot"]>;
/** A prefixed id, `per_…`: a cost event's subject. */
const prefixedId = z.string().regex(/^[a-z][a-z0-9]*_[0-9A-Za-z]+$/);
const spendBody = z.strictObject({
  quantity: z.int().min(1).max(100),
  key: z
    .string()
    .regex(/^[a-z0-9:-]{1,60}$/)
    .optional(),
});
const costsBody = z.strictObject({
  costs: z
    .array(
      z.strictObject({
        feature: z.string().regex(/^[a-z][a-z0-9_]*$/),
        vendor: z.string().regex(/^[a-z][a-z0-9-]*$/),
        unitCost: z.string().regex(/^\d+(?:\.\d+)?$/),
        subjectRef: prefixedId.optional(),
      }),
    )
    .max(20),
});
/** A draft's channel and columns as messaging's factory reads them; the table checks their values. */
const draft = z.record(z.string(), z.unknown());
const draftsBody = z.strictObject({
  personId: z.string().min(1).max(64),
  drafts: z.array(draft).max(10),
});

@Controller()
export class E2eController {
  @Post("leads")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Replaces the workspace's leads with these, in this order; the persons stay",
    body: leadsBody,
    response: z.strictObject({ personIds: z.array(z.string()) }),
  })
  async leads(@Body() body: LeadsBody): Promise<{ personIds: string[] }> {
    await tenantClient.reviewDecision.deleteMany({});
    await tenantClient.lead.deleteMany({});
    await tenantClient.scoreSnapshot.deleteMany({});
    const personIds: string[] = [];
    for (const { slug, source, sources, decision, snapshot, ...fields } of body.leads) {
      const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, ...fields };
      const from = source === "imported" ? "import" : "linkedin";
      const provider = source === "imported" ? "csv" : "unipile";
      const { person } = await upsertPersonFromSource({ source: from, provider, profile });
      const personId = person.id;
      const entries: Entry[] = sources ?? [{ kind: source, ref: "e2e" }];
      for (const { at, ...entry } of entries) {
        const given = { ...entry, at: at === undefined ? undefined : new Date(at) };
        await createLeadForPerson({ personId, source: given as LeadSource });
      }
      const snapshotId = snapshot && (await writeSnapshot(personId, snapshot));
      if (decision) await applyQualification({ ...decision, personId, snapshotId } as Decision);
      personIds.push(personId);
    }
    return { personIds };
  }

  @Post("spend")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Spends `quantity` units of e2e.batch: a reserve and its commit",
    body: spendBody,
    response: z.strictObject({ usageId: z.string(), credits: z.string() }),
  })
  async spend(@Body() { quantity, key }: z.infer<typeof spendBody>) {
    const { workspaceId } = currentTenant();
    const workspace = await tenantClient.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    if (workspace) {
      await tenantClient.$queryRaw`SELECT credits_seed_self_hosted(${workspace.organizationId})`;
    }
    const { usageId } = await credits.reserve({
      workspaceId,
      action: prices["e2e.batch"],
      quantity,
      idempotencyKey: `e2e:${key ?? randomUUID()}`,
      subjectRef: "e2e_batch",
      lease: "sync",
    });
    return credits.commit(usageId);
  }

  @Post("drafts")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Replaces the person's message drafts with these, oldest first",
    body: draftsBody,
    response: z.strictObject({ draftIds: z.array(z.string()) }),
  })
  async drafts(@Body() { personId, drafts }: z.infer<typeof draftsBody>) {
    const { workspaceId } = currentTenant();
    await tenantClient.messageDraft.deleteMany({ where: { personId } });
    const draftIds: string[] = [];
    for (const [index, columns] of drafts.entries()) {
      // A second apart, so that the list's newest first is the body's order reversed.
      const createdAt = new Date(Date.now() - (drafts.length - index) * 1_000);
      const input = { ...(columns as SeededDraft), workspaceId, personId, createdAt };
      draftIds.push(await createMessageDraft(input, tenantClient));
    }
    return { draftIds };
  }

  @Post("drafts/:id")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Writes a drafting draft as its writer leaves it, in the worker's stead",
    params: z.strictObject({ id: z.string().min(1).max(64) }),
    body: draft,
    response: z.strictObject({ written: z.int() }),
  })
  async written(@Param("id") id: string, @Body() columns: Record<string, unknown>) {
    return { written: await writeMessageDraft(id, columns as SeededDraft, tenantClient) };
  }

  @Post("costs")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Replaces the workspace's cost events with these, created now",
    body: costsBody,
    response: z.strictObject({ count: z.int() }),
  })
  async costs(@Body() body: z.infer<typeof costsBody>): Promise<{ count: number }> {
    const { workspaceId } = currentTenant();
    await tenantClient.costEvent.deleteMany({});
    const data = body.costs.map(({ subjectRef, ...cost }) => ({
      ...cost,
      id: newId(platformIds.cost_event),
      workspaceId,
      units: { calls: 1 },
      priceListVersion: "e2e",
      subjectRef: subjectRef ?? null,
    }));
    return tenantClient.costEvent.createMany({ data });
  }
}

/** The person's snapshot, scored, and its verdicts: the rows qualification writes (its docs/data.md). */
async function writeSnapshot(personId: string, { verdicts, ...snapshot }: Snapshot) {
  const { workspaceId } = currentTenant();
  const id = newId("ssn");
  const model = { modelId: "fake-model", promptVersion: 1, scorerVersion: "fit-v1" };
  const row = { ...snapshot, ...model, id, workspaceId, personId, decisionRecordId: `dr_${id}` };
  await tenantClient.scoreSnapshot.create({ data: row as Prisma.ScoreSnapshotCreateInput });
  const rows = verdicts.map((verdict) => ({ ...verdict, id: newId("cvd"), workspaceId }));
  const data = rows.map((verdict) => ({ ...verdict, snapshotId: id }));
  await tenantClient.criterionVerdict.createMany({
    data: data as Prisma.CriterionVerdictCreateManyInput[],
  });
  return id;
}

@Module({ controllers: [E2eController] })
export class E2eApi {}
