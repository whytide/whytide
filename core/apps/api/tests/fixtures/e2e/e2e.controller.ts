// The e2e module's routes (index.ts), for the web's end-to-end tests only (lead-list.spec.ts,
// lead-page.spec.ts, review-panel.spec.ts, messaging-draft-panel.spec.ts,
// credits-screen.spec.ts, contacts-never-contact.spec.ts, contacts-approve.spec.ts,
// approvals-up-next.spec.ts, campaigns-enrollment-panel.spec.ts, linkedin-switches.spec.ts,
// inbox-screen.spec.ts, linkedin-disclosure.spec.ts, campaigns-counts.spec.ts,
// linkedin-health.spec.ts):
// - POST …/e2e/leads replaces the workspace's leads, and their review decisions and status changes,
//   with the ones the body lists, each person and lead written by contacts' own commands, as an
//   import or a signal (the sources the body gives) and qualification write them, and a lead's
//   snapshot, if any, with its verdicts, as qualification stores and scores one (it has no command
//   that writes one without the model); it empties the never-contact list first, then links a
//   person to the company the body names and records the opt-outs it names as a reply's "stop"
//   will (contacts' upsertCompany, linkPersonToCompany and addOptOut);
// - POST …/e2e/spend spends credits as a batch does, through credits' reserve and commit, after the
//   organization's grant for the period, which the worker (absent here) gives a new organization;
//   with a `key`, once for that key;
// - POST …/e2e/drafts replaces a person's message drafts with the ones the body lists, oldest first,
//   and POST …/e2e/drafts/{id} writes a `drafting` one as its writer leaves it, in the worker's
//   stead: both through messaging's factory (its @whytide/messaging/testing);
// - POST …/e2e/costs replaces the workspace's cost events with the ones the body lists, as callAgent
//   records them, created now;
// - POST …/e2e/up-next replaces the workspace's approval items and step drafts with the ones the body
//   lists, sent from the signed-in user's account, connected, in the zone the body gives: each draft
//   by messaging's factory, each item by approvals' (@whytide/approvals/testing), a drafting one's
//   without its draft; POST …/e2e/up-next/drafts/{id} writes a drafting one as its writer leaves it
//   and attaches it to its item as approvals' subscriber does, in the worker's stead;
// - POST …/e2e/enrollments replaces a person's enrollments and their steps with the ones the body
//   lists, oldest first, in the statuses it names, as campaigns and its sender leave them (the e2e
//   api runs no worker): a started one sent from the workspace's connected account;
// - POST …/e2e/linkedin-controls sets the platform's stop, the workspace's and the signed-in user's
//   account's pause, each held by the tester or the operator or lifted, as the operator's command
//   (beta-p1-060) leaves them: through linkedin's testing helpers (@whytide/linkedin/testing);
// - POST …/e2e/inbox replaces the workspace's threads, their messages and their replies' labels
//   with the ones the body lists, each thread's messages oldest first, as the receiver and the
//   label leave them (the e2e api runs no worker): through inbox's testing helpers
//   (@whytide/inbox/testing), each thread on the signed-in user's account, a label theirs;
// - POST …/e2e/linkedin-disclosure sets the signed-in user's account back to alpha's disclosure,
//   version 1 without the personal-account confirmation, as an account connected in alpha is;
// - POST …/e2e/counts replaces the workspace's enrollments and their steps with the ones the body
//   lists, each for a person of its own, in the statuses and at the times it gives, as campaigns and
//   its sender leave them (the e2e api runs no worker): through campaigns' createEnrollment
//   (@whytide/campaigns/testing), from the signed-in user's account, connected with the label and
//   the zone the body gives, or from an account id linkedin does not hold;
// - POST …/e2e/linkedin-health sets the signed-in user's account's health (setHealth), an event into
//   a new state, the cool-down's end, a pairing before it and, as the worker would, a status check.
import { randomUUID } from "node:crypto";
import { Body, Controller, HttpCode, Module, Param, Post } from "@nestjs/common";
import {
  addOptOut,
  applyQualification,
  createLeadForPerson,
  linkPersonToCompany,
  upsertCompany,
  upsertPersonFromSource,
} from "@whytide/contacts";
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
const { createMessageDraft, createStepDraft, writeMessageDraft }: MessagingTesting = await import(
  new URL("../../../../../../modules/messaging/dist/testing/index.js", import.meta.url).href
);
// approvals' factory, by its build's path too: "Up next" is a screen.
type ApprovalsTesting = typeof import("../../../../../modules/approvals/dist/testing/index.js");
const { attachStepDraft, createApprovalItem }: ApprovalsTesting = await import(
  new URL("../../../../../../modules/approvals/dist/testing/index.js", import.meta.url).href
);
// linkedin's switches the same way: the api's e2e server loads linkedin by its build too.
type LinkedinTesting = typeof import("../../../../../modules/linkedin/dist/testing/index.js");
const {
  createHealthEvent,
  setAccountPaused,
  setHealth,
  setPlatformControls,
  setWorkspaceStopped,
}: LinkedinTesting = await import(
  new URL("../../../../../../modules/linkedin/dist/testing/index.js", import.meta.url).href
);
// inbox's helpers too: the e2e server loads inbox by its build.
type InboxTesting = typeof import("../../../../../modules/inbox/dist/testing/index.js");
const { createLabel, createMessage, createThread }: InboxTesting = await import(
  new URL("../../../../../../modules/inbox/dist/testing/index.js", import.meta.url).href
);
// campaigns' helper too: the counts page is a screen.
type CampaignsTesting = typeof import("../../../../../modules/campaigns/dist/testing/index.js");
const { createEnrollment }: CampaignsTesting = await import(
  new URL("../../../../../../modules/campaigns/dist/testing/index.js", import.meta.url).href
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
  /** The person's company, upsertCompany's profile, which contacts checks, linked to the person. */
  company: z.looseObject({ name: z.string().max(120) }).optional(),
  /** The person opted out in a reply: addOptOut by the system, `reply_opt_out`. */
  optedOut: z.boolean().optional(),
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
type Company = Parameters<typeof upsertCompany>[0]["company"];
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
const upNextBody = z.strictObject({
  /** The sender account's zone, an IANA name, which the table takes as given. */
  timeZone: z.string().min(1).max(64),
  items: z
    .array(
      z.strictObject({
        personId: z.string().min(1).max(64),
        stepKey: z.enum(["connect", "message_1", "follow_up_1", "follow_up_2"]),
        scheduledFor: z.iso.datetime(),
        createdAt: z.iso.datetime().optional(),
        /** The step draft's columns; a `drafting` one is not attached to the item yet. */
        draft,
      }),
    )
    .max(20),
});
const UP_NEXT_ACCOUNT = {
  label: "Up next e2e",
  status: "connected" as const,
  provider: "fake",
  workingHours: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] },
};
/** campaigns' template (its domain/template/constants.ts): its id and version, and by step key… */
const TEMPLATE = { templateId: "linkedin_default", templateVersion: 1 } as const;
/** …each step's position and action. */
const TEMPLATE_STEPS = {
  connect: { position: 1, actionType: "invite" },
  message_1: { position: 2, actionType: "message" },
  follow_up_1: { position: 3, actionType: "message" },
  follow_up_2: { position: 4, actionType: "message" },
} as const;
/** A step's statuses (campaigns' StepExecutionStatus). */
const STEP_STATUSES = [
  "planned",
  "awaiting_approval",
  "scheduled",
  "executing",
  "succeeded",
  "failed",
  "skipped",
  "held",
  "cancelled",
] as const;
/** A reason code; the panel words the ones campaigns writes and says so for any other. */
const code = z.string().regex(/^[a-z][a-z_]{0,39}$/);
const enrollmentsBody = z.strictObject({
  personId: z.string().min(1).max(64),
  enrollments: z
    .array(
      z.strictObject({
        status: z.enum(["active", "replied", "completed", "exited"]),
        /** Set exactly when the status is exited: the table's CHECK refuses anything else. */
        exitReason: z
          .enum(["suppressed", "removed", "no_sender", "not_accepted", "send_refused"])
          .optional(),
        exitDetail: code.optional(),
        /** Whether its sequence started, from the workspace's connected account: unless exited. */
        started: z.boolean().optional(),
        steps: z
          .array(
            z.strictObject({
              stepKey: z.enum(["connect", "message_1", "follow_up_1", "follow_up_2"]),
              status: z.enum(STEP_STATUSES),
              dueAt: z.iso.datetime().optional(),
              scheduledFor: z.iso.datetime().optional(),
              executedAt: z.iso.datetime().optional(),
              skipReason: code.optional(),
              errorCode: code.optional(),
            }),
          )
          .max(4)
          .optional(),
      }),
    )
    .max(5),
});
/** Who holds a stop, or null: lifted. */
const holder = z.enum(["tester", "operator"]).nullable();
const linkedinControlsBody = z.strictObject({
  /** The platform's stop of every LinkedIn action, the operator's. */
  platformStopped: z.boolean(),
  /** The workspace's stop. */
  workspace: holder,
  /** The signed-in user's account's pause, when the user has an account in the workspace. */
  account: holder,
});
const inboxBody = z.strictObject({
  threads: z
    .array(
      z.strictObject({
        personId: z.string().min(1).max(64),
        /** Oldest first: the thread's last message time is the last one's. */
        messages: z
          .array(
            z.strictObject({
              direction: z.enum(["in", "out"]),
              /** An outbound message's sender: the campaign, approved at `approvedAt`, or the user. */
              sentBy: z.enum(["campaign", "user"]).optional(),
              body: z.string().min(1).max(500),
              sentAt: z.iso.datetime(),
              approvedAt: z.iso.datetime().optional(),
              /** A reply's label, chosen by the signed-in user. */
              label: z.enum(["positive", "not_positive"]).optional(),
            }),
          )
          .max(10),
      }),
    )
    .max(30),
});
const countsBody = z.strictObject({
  /** The signed-in user's account: its label, and its zone, an IANA name the table takes as given. */
  account: z.strictObject({
    label: z.string().min(1).max(100),
    timeZone: z.string().min(1).max(64),
  }),
  enrollments: z
    .array(
      z.strictObject({
        /** From an account id linkedin does not hold, rather than the signed-in user's account. */
        removedAccount: z.boolean().optional(),
        /** An exited one's reason is `removed`. */
        status: z.enum(["active", "replied", "completed", "exited"]),
        endedAt: z.iso.datetime().optional(),
        steps: z
          .array(
            z.strictObject({
              /** A key of the template, or another with its action: a withdrawal's. */
              stepKey: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
              actionType: z.enum(["invite", "message", "withdraw"]).optional(),
              status: z.enum(STEP_STATUSES),
              executedAt: z.iso.datetime().optional(),
              acceptedAt: z.iso.datetime().optional(),
            }),
          )
          .max(5),
      }),
    )
    .max(40),
});
/** The signed-in user's account on the counts page, connected, and an account linkedin does not hold. */
const COUNTS_ACCOUNT = {
  status: "connected" as const,
  provider: "fake",
  workingHours: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] },
};
const REMOVED_ACCOUNT = "sac_e2e_counts_removed";
/** A warning's cool-down: paused_until 72 hours after the change. */
const COOLDOWN_MS = 72 * 3_600_000;
/** The trigger of the seeded event into each state. */
const HEALTH_TRIGGERS = {
  healthy: "manual",
  at_risk: "acceptance_rate",
  restricted: "limit_reached",
  checkpoint: "checkpoint",
  disconnected: "session_invalid",
} as const;
const linkedinHealthBody = z.strictObject({
  /** The signed-in user's account's health; an event into it when it changes. */
  state: z.enum(["healthy", "at_risk", "restricted", "checkpoint", "disconnected"]),
  /** Restricted or checkpoint: minutes from now to the cool-down's end, negative once it is over. */
  cooldownEndsIn: z.int().min(-6_000).max(6_000).optional(),
  /** Minutes since the worker last read the status, as "Check status" leaves it; one by default. */
  statusCheckedAgo: z.int().min(0).max(6_000).optional(),
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
    await tenantClient.leadStatusChange.deleteMany({});
    await tenantClient.lead.deleteMany({});
    await tenantClient.scoreSnapshot.deleteMany({});
    // Opt-outs included, which no route removes: each spec's run starts from an empty list.
    await tenantClient.suppressionEntry.deleteMany({});
    const personIds: string[] = [];
    for (const lead of body.leads) {
      const { slug, source, sources, decision, snapshot, company, optedOut, ...fields } = lead;
      const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, ...fields };
      const from = source === "imported" ? "import" : "linkedin";
      const provider = source === "imported" ? "csv" : "unipile";
      const { person } = await upsertPersonFromSource({ source: from, provider, profile });
      const personId = person.id;
      if (company) {
        const written = await upsertCompany({
          source: from,
          provider,
          company: company as Company,
        });
        await linkPersonToCompany({ personId, companyId: written.company.id });
      }
      if (optedOut) await addOptOut(personId, { source: "system", reason: "reply_opt_out" });
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

  @Post("up-next")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Replaces the workspace's approval items and step drafts with these",
    body: upNextBody,
    response: z.strictObject({
      items: z.array(z.strictObject({ id: z.string(), draftId: z.string() })),
    }),
  })
  async upNext(@Body() { timeZone, items }: z.infer<typeof upNextBody>) {
    const { workspaceId, principal } = currentTenant();
    await tenantClient.approvalItem.deleteMany({});
    await tenantClient.messageDraft.deleteMany({ where: { kind: "outbound_step" } });
    const owner = { workspaceId, ownerUserId: principal.userId };
    const account = { ...UP_NEXT_ACCOUNT, timeZone };
    const { id: senderAccountId } = await tenantClient.senderAccount.upsert({
      where: { workspaceId_ownerUserId: owner },
      create: { id: newId("sac"), ...owner, ...account, disclosureAcknowledgedAt: new Date() },
      update: account,
      select: { id: true },
    });
    const seeded: { id: string; draftId: string }[] = [];
    for (const { personId, stepKey, scheduledFor, createdAt, draft: columns } of items) {
      // campaigns' step id, which the e2e api, without campaigns, cannot draw from its prefix.
      const stepExecutionId = `sx_e2e${randomUUID().replaceAll("-", "")}`;
      const step = { workspaceId, personId, stepExecutionId, stepKey };
      const draftId = await createStepDraft({ ...(columns as SeededDraft), ...step }, tenantClient);
      const item = {
        ...step,
        senderAccountId,
        scheduledFor: new Date(scheduledFor),
        draftId: columns.status === "drafting" ? null : draftId,
        ...(createdAt === undefined ? {} : { createdAt: new Date(createdAt) }),
      };
      seeded.push({ id: await createApprovalItem(item, tenantClient), draftId });
    }
    return { items: seeded };
  }

  @Post("up-next/drafts/:id")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Writes a drafting step draft as its writer leaves it, then attaches it to its item",
    params: z.strictObject({ id: z.string().min(1).max(64) }),
    body: draft,
    response: z.strictObject({ written: z.int(), attached: z.int() }),
  })
  async upNextDraft(@Param("id") id: string, @Body() columns: Record<string, unknown>) {
    const written = await writeMessageDraft(id, columns as SeededDraft, tenantClient);
    const where = { id, kind: "outbound_step" as const };
    const select = { stepExecutionId: true };
    const ended = await tenantClient.messageDraft.findFirst({ where, select });
    const stepExecutionId = ended?.stepExecutionId;
    if (!stepExecutionId) return { written, attached: 0 };
    const attached = await attachStepDraft({ draftId: id, stepExecutionId }, tenantClient);
    return { written, attached };
  }

  @Post("linkedin-controls")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Sets the platform's stop, the workspace's and the signed-in user's account's pause, held by the tester or the operator or lifted",
    body: linkedinControlsBody,
    response: z.strictObject({ accountId: z.string().nullable() }),
  })
  async linkedinControls(@Body() body: z.infer<typeof linkedinControlsBody>) {
    const { workspaceId, principal } = currentTenant();
    await setPlatformControls({ stopped: body.platformStopped });
    await setWorkspaceStopped(workspaceId, body.workspace);
    const account = await tenantClient.senderAccount.findFirst({
      where: { ownerUserId: principal.userId },
      select: { id: true },
    });
    if (account !== null) await setAccountPaused(account.id, body.account);
    return { accountId: account?.id ?? null };
  }

  @Post("linkedin-disclosure")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Sets the signed-in user's account back to alpha's disclosure: version 1, no personal-account confirmation",
    response: z.strictObject({ accountId: z.string().nullable() }),
  })
  async linkedinDisclosure() {
    const where = { ownerUserId: currentTenant().principal.userId };
    const account = await tenantClient.senderAccount.findFirst({ where, select: { id: true } });
    const data = { disclosureVersion: 1, personalAccountConfirmedAt: null };
    if (account !== null) await tenantClient.senderAccount.update({ where: account, data });
    return { accountId: account?.id ?? null };
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

  @Post("enrollments")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Replaces the person's enrollments and their steps with these, oldest first",
    body: enrollmentsBody,
    response: z.strictObject({ enrollmentIds: z.array(z.string()) }),
  })
  async enrollments(@Body() { personId, enrollments }: z.infer<typeof enrollmentsBody>) {
    const { workspaceId } = currentTenant();
    // Steps first: a step's key to its enrollment refuses the enrollment's deletion.
    await tenantClient.stepExecution.deleteMany({ where: { personId } });
    await tenantClient.enrollment.deleteMany({ where: { personId } });
    const account = await tenantClient.senderAccount.findFirst({
      where: { status: "connected" },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const date = (at: string | undefined) => (at === undefined ? null : new Date(at));
    const enrollmentIds: string[] = [];
    for (const [index, seeded] of enrollments.entries()) {
      const { steps = [], started = seeded.status !== "exited", ...columns } = seeded;
      const senderAccountId = started ? account?.id : null;
      if (senderAccountId === undefined) throw new Error("e2e: no connected sender account");
      // A second apart, so that the panel's newest first is the body's order reversed.
      const createdAt = new Date(Date.now() - (enrollments.length - index) * 1_000);
      const id = newId("enl");
      await tenantClient.enrollment.create({
        data: {
          ...{ ...columns, ...TEMPLATE, id, workspaceId, personId, senderAccountId, createdAt },
          sourceEventId: newId(platformIds.outbox_entry),
          startedAt: started ? createdAt : null,
          endedAt: seeded.status === "active" ? null : createdAt,
        },
      });
      for (const { stepKey, dueAt, scheduledFor, executedAt, ...step } of steps) {
        if (senderAccountId === null) throw new Error("e2e: a step needs a started enrollment");
        const stepId = newId("sx");
        // The hash and the key stand in for campaigns' SHA-256s: no check reads them here.
        const keys = { stepTemplateHash: stepKey, idempotencyKey: stepId };
        await tenantClient.stepExecution.create({
          data: {
            ...{ ...step, ...TEMPLATE_STEPS[stepKey], ...TEMPLATE, ...keys, stepKey },
            ...{ id: stepId, workspaceId, enrollmentId: id, personId, senderAccountId },
            ...{ dueAt: date(dueAt), scheduledFor: date(scheduledFor) },
            executedAt: date(executedAt),
          },
        });
      }
      enrollmentIds.push(id);
    }
    return { enrollmentIds };
  }

  @Post("inbox")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary: "Replaces the workspace's threads, messages and labels with these",
    body: inboxBody,
    response: z.strictObject({
      threads: z.array(z.strictObject({ id: z.string(), messageIds: z.array(z.string()) })),
    }),
  })
  async inbox(@Body() { threads }: z.infer<typeof inboxBody>) {
    const { workspaceId, principal } = currentTenant();
    const labeledBy = principal.userId;
    // Labels, then messages: a message's key to its thread refuses the thread's deletion.
    await tenantClient.replyLabel.deleteMany({});
    await tenantClient.message.deleteMany({});
    await tenantClient.thread.deleteMany({});
    const seeded: { id: string; messageIds: string[] }[] = [];
    for (const { personId, messages } of threads) {
      const last = messages.at(-1)?.sentAt;
      const lastMessageAt = last === undefined ? new Date() : new Date(last);
      const thread = { workspaceId, personId, ownerUserId: labeledBy, lastMessageAt };
      const threadId = await createThread(thread, tenantClient);
      const messageIds: string[] = [];
      for (const { sentAt, approvedAt, label, ...columns } of messages) {
        const approved = approvedAt === undefined ? undefined : new Date(approvedAt);
        const times = { sentAt: new Date(sentAt), approvedAt: approved };
        const message = { ...columns, ...times, workspaceId, threadId, personId };
        const messageId = await createMessage(message, tenantClient);
        if (label) await createLabel({ workspaceId, messageId, label, labeledBy }, tenantClient);
        messageIds.push(messageId);
      }
      seeded.push({ id: threadId, messageIds });
    }
    return { threads: seeded };
  }

  @Post("counts")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Replaces the workspace's enrollments and steps with these, from the signed-in user's account",
    body: countsBody,
    response: z.strictObject({ accountId: z.string() }),
  })
  async counts(@Body() { account, enrollments }: z.infer<typeof countsBody>) {
    const { workspaceId, principal } = currentTenant();
    // Steps first: a step's key to its enrollment refuses the enrollment's deletion.
    await tenantClient.stepExecution.deleteMany({});
    await tenantClient.enrollment.deleteMany({});
    const owner = { workspaceId, ownerUserId: principal.userId };
    const columns = { ...COUNTS_ACCOUNT, ...account };
    const { id: accountId } = await tenantClient.senderAccount.upsert({
      where: { workspaceId_ownerUserId: owner },
      create: { id: newId("sac"), ...owner, ...columns, disclosureAcknowledgedAt: new Date() },
      update: columns,
      select: { id: true },
    });
    const date = (at: string | undefined) => (at === undefined ? undefined : new Date(at));
    for (const { removedAccount, endedAt, steps, ...enrollment } of enrollments) {
      const seeded = {
        ...{ ...enrollment, workspaceId, personId: newId("per"), endedAt: date(endedAt) },
        senderAccountId: removedAccount ? REMOVED_ACCOUNT : accountId,
        steps: steps.map(({ executedAt, acceptedAt, ...step }) => ({
          ...{ ...step, executedAt: date(executedAt), acceptedAt: date(acceptedAt) },
        })),
      };
      await createEnrollment(seeded, tenantClient);
    }
    return { accountId };
  }

  @Post("linkedin-health")
  @HttpCode(200)
  @Permission(permissions["e2e.write"])
  @ApiRoute({
    summary:
      "Sets the signed-in user's account's health, its cool-down's end and its status's last check, with an event into a new state",
    body: linkedinHealthBody,
    response: z.strictObject({ accountId: z.string().nullable() }),
  })
  async linkedinHealth(@Body() body: z.infer<typeof linkedinHealthBody>) {
    const where = { ownerUserId: currentTenant().principal.userId };
    const select = { id: true, healthState: true };
    const account = await tenantClient.senderAccount.findFirst({ where, select });
    if (account === null) return { accountId: null };
    const now = Date.now();
    const { state, cooldownEndsIn = -60, statusCheckedAgo = 1 } = body;
    const cooling = state === "restricted" || state === "checkpoint";
    const pausedUntil = cooling ? new Date(now + cooldownEndsIn * 60_000) : null;
    const at = new Date(pausedUntil === null ? now : pausedUntil.getTime() - COOLDOWN_MS);
    if (account.healthState !== state) {
      const event = { from: account.healthState, to: state, trigger: HEALTH_TRIGGERS[state] };
      await createHealthEvent(account.id, { ...event, at, pausedUntil });
    }
    await setHealth(account.id, state, { pausedUntil, at });
    // Paired before the change, so that a checkpoint's resume waits for a pairing.
    const connectedAt = new Date(at.getTime() - 3_600_000);
    const data = { connectedAt, statusCheckedAt: new Date(now - statusCheckedAgo * 60_000) };
    await tenantClient.senderAccount.update({ where: { id: account.id }, data });
    return { accountId: account.id };
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
