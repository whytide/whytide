// The setup the module's test files share (tests/*.test.ts, tests/safety/*.test.ts), each file on
// its own schema (withTestDb, called by the file): a workspace's runs, its approver as its Owner
// (gamma-p6-040: a campaign sends from its owner's account, the seeded one from the workspace's
// Owner's, while the owner is an active member), the approver's connected account, an approved lead
// enrolled by the subscriber's body, a step moved as later tasks will move it, a step queued, its
// draft written and its item decided as approvals' routes leave the rows (its commands are its
// routes' only), by the item's account's owner unless a test says, the decision delivered, and the
// rows as the tests read them.
import { createHash } from "node:crypto";
import { attachStepDraft } from "@whytide/approvals/testing";
import { createLeadForPerson, recordLeadStatus, upsertPersonFromSource } from "@whytide/contacts";
import { type PrismaClient, type TenantClient, withTenant } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { createConnectedAccount } from "@whytide/linkedin/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { createMembership, createOrganizationWithWorkspace } from "@whytide/tenancy/testing";
import { applyDecision, type DecisionOutcome } from "../domain/decisions.ts";
import { enrollApproved } from "../domain/enroll/enroll.ts";
import type { QueueOutcome } from "../domain/queue/constants.ts";
import { queueStep } from "../domain/queue/open.ts";
import type { StepKey } from "../domain/template/constants.ts";

export const APPROVER = "usr_campaigns_approver";

type StepStatus = "planned" | "awaiting_approval" | "scheduled" | "executing" | "succeeded";
/** A step as the tests read it. */
export type StepRow = {
  readonly id: string;
  readonly stepKey: string;
  readonly status: string;
  readonly skipReason: string | null;
  readonly errorCode: string | null;
  readonly jitChecks: unknown;
};
/** An enrollment as the tests read it. */
export type EnrollmentRow = {
  readonly status: string;
  readonly exitReason: string | null;
  readonly exitDetail: string | null;
  readonly endedAt: Date | null;
};
/** An enrolled lead: the person's id, the enrollment's and the steps' by key. */
export type Enrolled = {
  readonly personId: string;
  readonly enrollmentId: string;
  readonly steps: Record<StepKey, string>;
};
export type Fixture = {
  readonly app: () => PrismaClient;
  readonly run: <T>(fn: (tx: TenantClient) => Promise<T>) => Promise<T>;
  /**
   * The approver an active Owner of the workspace, its row and its organization written unless the
   * test has; the oldest Owner, whose the seeded campaign is, unless the test made one before.
   */
  readonly owned: () => Promise<typeof APPROVER>;
  /** The approver's connected account, in the zone given (UTC by default), the approver owning. */
  readonly account: (timeZone?: string) => Promise<{ id: string }>;
  /**
   * A person whose lead is approved as Approve leaves it (contacts' approveLead is its route's
   * only), enrolled by the subscriber's body; with `email`, a person known by that address alone,
   * with no LinkedIn profile (gamma-rf-050).
   */
  readonly enrolledLead: (slug: string, keys?: { readonly email: string }) => Promise<Enrolled>;
  /** The step moved as the queue, the approval or the sender's claim will (beta-p3-050, p4-020). */
  readonly moveStep: (id: string, status: StepStatus) => Promise<void>;
  /** The person's steps by position. */
  readonly stepsOf: (personId: string) => Promise<StepRow[]>;
  readonly enrollmentOf: (id: string) => Promise<EnrollmentRow>;
  /** The lead's outreach status and its status changes, oldest first, as `from>to`. */
  readonly leadOf: (personId: string) => Promise<{ status: string; changes: string[] }>;
  /** The step due at `at`, as the enrollment, the acceptance or a send leaves it. */
  readonly dueAt: (id: string, at: Date) => Promise<void>;
  /** queueStep in a run: the step's turn in a queue run. */
  readonly queue: (id: string) => Promise<QueueOutcome>;
  /** The step's latest item, as approvals holds it; null for none. */
  readonly itemOf: (id: string) => Promise<ItemRow | null>;
  /** The step's message draft ended `ready` with the text, as its writer leaves it, and attached. */
  readonly draftReady: (id: string, text: string) => Promise<void>;
  /**
   * The step's item approved by `by` (its account's owner unless given), as approve leaves it: the
   * draft frozen.
   */
  readonly approveItem: (id: string, by?: string) => Promise<string>;
  /** The step's item skipped by the approver at `at` (now), as skip leaves it. */
  readonly skipItem: (id: string, at?: Date) => Promise<string>;
  /** approvals.item_decided delivered for the step's latest item: the subscriber's body in a run. */
  readonly decide: (id: string) => Promise<DecisionOutcome>;
  /** A connection request queued, approved and decided: `scheduled`, as the sender finds it. */
  readonly approved: (id: string) => Promise<string>;
};
/** An item as the tests read it. */
export type ItemRow = {
  readonly id: string;
  readonly status: string;
  readonly draftId: string | null;
  readonly actionType: string;
  readonly stepKey: string;
  /** Null on an email item, whose sender is its mailbox (approvals, gamma-p4-090). */
  readonly senderAccountId: string | null;
  readonly scheduledFor: Date;
};

/** The helpers of one workspace. */
export function fixture(workspaceId: string): Fixture {
  const app = () => asRole("app");
  const run = <T>(fn: (tx: TenantClient) => Promise<T>) =>
    withTenant({ workspaceId, principal: servicePrincipal("campaigns_test") }, fn, {
      client: app(),
    });
  async function owned(): Promise<typeof APPROVER> {
    const workspace = await app().workspace.findUnique({ where: { id: workspaceId } });
    if (workspace === null) await createOrganizationWithWorkspace({ workspaceId });
    const user = { id: APPROVER, email: `${APPROVER}@example.com` };
    await app().user.upsert({ where: { id: APPROVER }, create: user, update: {} });
    const member = { workspaceId, userId: APPROVER };
    if ((await app().membership.count({ where: member })) === 0) {
      await createMembership({ ...member, role: "Owner" });
    }
    return APPROVER;
  }
  async function account(timeZone?: string) {
    await owned();
    return createConnectedAccount(workspaceId, { ownerUserId: APPROVER, timeZone });
  }

  async function enrolledLead(slug: string, keys?: { email: string }): Promise<Enrolled> {
    const personId = await run(async () => {
      const profile =
        keys === undefined
          ? { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" }
          : { email: keys.email, firstName: "Noor" };
      const { person } = await upsertPersonFromSource({
        source: "import",
        provider: "csv",
        profile,
      });
      const source = { kind: "imported", ref: "imp_1" } as const;
      await createLeadForPerson({ personId: person.id, source });
      await recordLeadStatus(person.id, "approved", { actor: { type: "user", id: APPROVER } });
      return person.id;
    });
    const approval = { sourceEventId: newId("obx"), personId, approvedBy: APPROVER };
    const outcome = await run((tx) => enrollApproved(tx, approval));
    if (outcome !== "enrolled") throw new Error(`enrolledLead: ${outcome}`);
    const rows = await app().stepExecution.findMany({ where: { personId } });
    const steps = Object.fromEntries(rows.map(({ stepKey, id }) => [stepKey, id]));
    const enrollmentId = rows[0]?.enrollmentId ?? "";
    return { personId, enrollmentId, steps: steps as Record<StepKey, string> };
  }

  async function itemOf(id: string): Promise<ItemRow | null> {
    return app().approvalItem.findFirst({
      where: { stepExecutionId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }
  async function pendingItemOf(id: string): Promise<ItemRow> {
    const item = await itemOf(id);
    if (item === null || item.status !== "pending") {
      throw new Error(`no pending item: ${item?.status ?? "none"}`);
    }
    return item;
  }
  const decided = (at: Date) =>
    ({ decidedBy: APPROVER, decidedAt: at, decisionOrigin: "app" }) as const;

  async function decide(id: string): Promise<DecisionOutcome> {
    const item = await itemOf(id);
    if (item === null) throw new Error("decide: no item");
    return run((tx) => applyDecision(tx, { approvalItemId: item.id, stepExecutionId: id }));
  }
  async function approveItem(id: string, by?: string): Promise<string> {
    const item = await pendingItemOf(id);
    // Its account's owner unless given, as approvals' approvedContent wants; an email item has none.
    const account =
      item.senderAccountId === null
        ? null
        : await app().senderAccount.findUnique({ where: { id: item.senderAccountId } });
    if (item.draftId === null) throw new Error("approveItem: the draft is being written");
    const draft = await app().messageDraft.update({
      where: { id: item.draftId },
      data: { status: "approved", approvedAt: new Date() },
    });
    const text = draft.editedText ?? draft.text ?? "";
    await app().approvalItem.update({
      where: { id: item.id },
      data: {
        status: "approved",
        approvedContentHash: sha256(text),
        ...decided(new Date()),
        decidedBy: by ?? account?.ownerUserId ?? APPROVER,
      },
    });
    return item.id;
  }

  return {
    app,
    run,
    owned,
    account,
    enrolledLead,
    async moveStep(id, status) {
      await app().stepExecution.update({ where: { id }, data: { status } });
    },
    async stepsOf(personId) {
      const rows = await app().stepExecution.findMany({
        where: { personId },
        orderBy: [{ createdAt: "asc" }, { position: "asc" }],
      });
      return rows.map(({ id, stepKey, status, skipReason, errorCode, jitChecks }) => ({
        ...{ id, stepKey, status, skipReason, errorCode, jitChecks },
      }));
    },
    async enrollmentOf(id) {
      const row = await app().enrollment.findUniqueOrThrow({ where: { id } });
      const { status, exitReason, exitDetail, endedAt } = row;
      return { status, exitReason, exitDetail, endedAt };
    },
    async leadOf(personId) {
      const lead = await app().lead.findFirstOrThrow({ where: { personId } });
      const changes = await app().leadStatusChange.findMany({
        where: { personId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      const steps = changes.map(({ fromStatus, toStatus }) => `${fromStatus}>${toStatus}`);
      return { status: lead.outreachStatus, changes: steps };
    },
    async dueAt(id, at) {
      await app().stepExecution.update({ where: { id }, data: { dueAt: at } });
    },
    queue: (id) => run(() => queueStep(id)),
    itemOf,
    async draftReady(id, text) {
      const draft = await app().messageDraft.findFirstOrThrow({ where: { stepExecutionId: id } });
      await app().messageDraft.update({ where: { id: draft.id }, data: { status: "ready", text } });
      await attachStepDraft({ draftId: draft.id, stepExecutionId: id }, app());
    },
    approveItem,
    async skipItem(id, at = new Date()) {
      const item = await pendingItemOf(id);
      await app().approvalItem.update({
        where: { id: item.id },
        data: { status: "skipped", ...decided(at) },
      });
      return item.id;
    },
    decide,
    async approved(id) {
      const outcome = await run(() => queueStep(id));
      if (outcome !== "opened") throw new Error(`approved: ${outcome}`);
      const itemId = await approveItem(id);
      if ((await decide(id)) !== "scheduled") throw new Error("approved: not scheduled");
      return itemId;
    },
  };
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
