// The setup the report's test files share (tests/report.test.ts, tests/report-cli.test.ts), each file
// on its own schema (withTestDb, called by the file), rows in end states: a lead by contacts'
// commands, signal-sourced or imported; a LinkedIn touch as campaigns' sender and linkedin's send
// activity leave it (a step `succeeded` and its `ok` log row); a log row naming no step, as a reply
// from the inbox's; and a person's reply with its owner's label and its classification
// (@whytide/inbox/testing). A person of the positive and agreement cases may be a bare id: those
// figures read no lead. Made-up names only.
import { randomUUID } from "node:crypto";
import type { ReplyActionLabel } from "@whytide/campaigns";
import { createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { withTenant } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { ids as linkedinIds } from "@whytide/linkedin";
import { newId, servicePrincipal } from "@whytide/platform";
import {
  createClassification,
  createLabel,
  createMessage,
  createThread,
} from "../testing/index.ts";

export const DAY_MS = 86_400_000;
const SENDER = "sac_report";
const OWNER = "usr_report_owner";
const TEMPLATE_ID = "linkedin_default";

/** The owner's label: one of the 7, or beta's word alone. */
export type OwnerLabel =
  | { readonly classLabel: ReplyActionLabel }
  | { readonly beta: "positive" | "not_positive" };
/** A classification: its label, suggested or not, by the model unless the origin is given. */
export type Classified = {
  readonly label: string;
  readonly isSuggested?: boolean;
  readonly origin?: "phrase" | "model" | "fallback";
};

export type ReportFixture = {
  /** A lead of the source given, made by contacts' commands: the person's id. */
  readonly lead: (kind: "signal" | "imported") => Promise<string>;
  /** A LinkedIn touch of the person at `at`: a campaign step sent and linkedin's `ok` row. */
  readonly touch: (personId: string, at: Date, kind?: "invite" | "message") => Promise<void>;
  /** linkedin's `ok` row naming no step at `at`: a reply from the inbox, or a withdrawal. */
  readonly logWithoutStep: (at: Date, kind: "message" | "withdraw") => Promise<void>;
  /** A reply of the person at `at` on their thread, with its owner's label and classification. */
  readonly reply: (
    personId: string,
    at: Date,
    given?: { readonly owner?: OwnerLabel; readonly classified?: Classified },
  ) => Promise<void>;
};

export function reportFixture(workspaceId: string): ReportFixture {
  const app = asRole("app");
  const threads = new Map<string, string>();
  const enrollments = new Map<string, { readonly id: string; steps: number }>();

  async function lead(kind: "signal" | "imported"): Promise<string> {
    return withTenant(
      { workspaceId, principal: servicePrincipal("inbox_test") },
      async () => {
        const linkedinUrl = `https://linkedin.com/in/lead-${randomUUID()}`;
        const profile = { linkedinUrl, firstName: "Ottoline", lastName: "Vashti" };
        const source = { source: "linkedin", provider: null } as const;
        const { person } = await upsertPersonFromSource({ ...source, profile });
        await createLeadForPerson({ personId: person.id, source: { kind, ref: "src_1" } });
        return person.id;
      },
      { client: app },
    );
  }

  async function logRow(objectRef: string | null, at: Date, kind: string): Promise<void> {
    const id = newId(linkedinIds.sender_action_log);
    const row = { id, workspaceId, senderAccountId: SENDER, objectRef, count: 1, outcome: "ok" };
    await app.senderActionLog.create({ data: { ...row, kind: kind as "invite", at } });
  }

  async function touch(personId: string, at: Date, kind: "invite" | "message" = "invite") {
    const owner = { workspaceId, personId, senderAccountId: SENDER, templateId: TEMPLATE_ID };
    // One active enrollment per person: a second touch is its next step.
    let enrollment = enrollments.get(personId);
    if (enrollment === undefined) {
      enrollment = { id: newId("enl"), steps: 0 };
      enrollments.set(personId, enrollment);
      await app.enrollment.create({
        data: {
          ...{ id: enrollment.id, ...owner, templateVersion: 1, status: "active" },
          ...{ sourceEventId: newId("obx"), startedAt: at },
        },
      });
    }
    enrollment.steps += 1;
    const step = { stepKey: `step_${enrollment.steps}`, position: enrollment.steps };
    const id = newId("sx");
    await app.stepExecution.create({
      data: {
        ...{ id, enrollmentId: enrollment.id, ...owner, templateVersion: 1, ...step },
        ...{ actionType: kind, status: "succeeded", executedAt: at },
        ...{ stepTemplateHash: randomUUID(), idempotencyKey: randomUUID() },
      },
    });
    await logRow(id, at, kind);
  }

  async function reply(
    personId: string,
    at: Date,
    given: { readonly owner?: OwnerLabel; readonly classified?: Classified } = {},
  ): Promise<void> {
    let threadId = threads.get(personId);
    if (threadId === undefined) {
      threadId = await createThread({
        workspaceId,
        personId,
        ownerUserId: OWNER,
        senderAccountId: SENDER,
      });
      threads.set(personId, threadId);
    }
    const messageId = await createMessage({ workspaceId, threadId, personId, sentAt: at });
    const { owner, classified } = given;
    if (owner !== undefined) {
      const labeled = { workspaceId, messageId, labeledBy: OWNER, labeledAt: at };
      await createLabel(
        "classLabel" in owner
          ? { ...labeled, classLabel: owner.classLabel }
          : { ...labeled, label: owner.beta },
      );
    }
    if (classified !== undefined) {
      const { label, isSuggested = false, origin = "model" } = classified;
      const confidence = origin === "phrase" ? 1 : isSuggested ? 0.5 : 0.9;
      await createClassification({
        ...{ workspaceId, messageId, threadId, personId },
        ...{ label, isSuggested, origin, confidence },
      });
    }
  }

  return {
    lead,
    touch,
    logWithoutStep: (at, kind) => logRow(kind === "message" ? newId("msg") : null, at, kind),
    reply,
  };
}
