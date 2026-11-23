// applyReplyLabel (README.md "Reply actions"; docs/flows.md "A reply's label"): the default action of
// a reply's label, the one function that decides every label, in the caller's tenant run (inbox's,
// gamma-p4-040), so the label and its action commit together or not at all. It acts on the person's
// `replied` enrollments that still have `held` steps. A label suggested and not opt_out does nothing.
// Any other call locks the lead, then the person's enrollments (every stop's order; the steps and
// the items after them), and changes nothing again for a label already acted on for the same reply.
// It first undoes what an earlier label scheduled: a reminder not yet sent is cleared, and an
// enrollment paused for an out-of-office reply is held again by holdForReply; the cool-down and a
// notice already published stay. Then it records the label and acts: interested, a notice;
// not_now, a reminder; not_interested, the held steps cancelled and a cool-down; out_of_office, the
// hold released and the enrollment paused (release-hold.ts, pause-end.ts); opt_out, an opt-out on
// every channel and the held steps cancelled; bounce (email's, later) and other, the label alone.
// Nothing lifts a suppression; no clock: the reply's instant times everything, with the days of
// settings.ts (README.md "Settings").
import { cancelItems } from "@whytide/approvals";
import { addOptOut, errors as contactsErrors, lockLeadStatus } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { AppError, currentTenant, publish } from "@whytide/platform";
import { z } from "zod";
import { events } from "../../events.ts";
import { settings } from "../../settings.ts";
import { ID_MAX, MS_PER_DAY } from "../constants.ts";
import { requireInstant } from "../gate/instant.ts";
import { holdForReply } from "../hold.ts";
import { pauseEnrollment } from "../pause/enrollment.ts";
import { checkedCode } from "../steps/codes.ts";
import { STEP_REASON_CODES } from "../steps/constants.ts";
import { lockEnrollment, timeZoneOf } from "../steps/skip.ts";
import {
  OOO_FALLBACK_ZONE,
  REPLY_ACTION_LABELS,
  RETURN_DATE,
  type ReplyAction,
  type ReplyActionLabel,
} from "./constants.ts";
import { outOfOfficeUntil } from "./pause-end.ts";
import { releaseHold } from "./release-hold.ts";

/** The opt-out a reply asks for, as inbox's store records one (contacts' system reason). */
const REPLY_OPT_OUT = { source: "system", reason: "reply_opt_out" } as const;

const id = z.string().min(1).max(ID_MAX);
/** A calendar date that exists: `YYYY-MM-DD` read back as itself. */
const calendarDate = z
  .string()
  .regex(RETURN_DATE)
  .refine((date) => {
    const midnight = new Date(`${date}T00:00:00Z`);
    return !Number.isNaN(midnight.getTime()) && midnight.toISOString().startsWith(date);
  });
const labelInput = z.object({
  label: z.enum(REPLY_ACTION_LABELS),
  /** A label the classification only suggested: below its confidence, for the member to confirm. */
  suggested: z.boolean(),
  /** The day an out-of-office reply names as its return, or null. */
  returnDate: calendarDate.nullable(),
  /** The reply's instant, as inbox stored it: the hold's, and what every time is counted from. */
  repliedAt: z.date(),
  /** inbox's thread of the reply, which the interested notice links. */
  threadId: id,
  /** The sender account's owner, whom the notices mail. */
  ownerUserId: id,
});
export type ReplyLabelInput = z.input<typeof labelInput>;

/** What a call did, as inbox keeps it (actions_taken): codes and ids, never a text. */
export type ReplyActionsTaken = {
  /** In order; none for a suggested label, a repeat, or nothing left to act on. */
  readonly actions: readonly ReplyAction[];
  /** The enrollments it acted on, the newest first. */
  readonly enrollmentIds: readonly string[];
};

type Reply = z.output<typeof labelInput>;
type Target = { readonly id: string; readonly senderAccountId: string | null };

const NOTHING: ReplyActionsTaken = { actions: [], enrollmentIds: [] };

/**
 * The label's default action on the person (the file's header), in the caller's tenant run; what
 * it did. person_not_found for no person id; an error naming the fields for an input off its rule.
 */
export async function applyReplyLabel(
  personId: string,
  input: ReplyLabelInput,
): Promise<ReplyActionsTaken> {
  // Prisma drops an undefined value from a where: unchecked, that would be every person's rows.
  if (typeof personId !== "string" || personId.trim() === "") {
    throw new AppError(contactsErrors.person_not_found);
  }
  const reply = parse(input);
  if (reply.suggested && reply.label !== "opt_out") return NOTHING;
  const enrollments = await lockEnrollments(personId);
  const repeat = enrollments.some(
    ({ replyLabel, replyLabelAt }) =>
      replyLabel === reply.label && replyLabelAt?.getTime() === reply.repliedAt.getTime(),
  );
  if (repeat) return NOTHING;

  const actions: ReplyAction[] = [];
  const cleared = await tenantClient.enrollment.updateMany({
    where: { personId, remindAt: { not: null }, remindedAt: null },
    data: { remindAt: null, remindUserId: null },
  });
  if (cleared.count > 0) actions.push("reminder_cleared");
  const away = ({ status, pausedReason }: (typeof enrollments)[number]) =>
    status === "paused" && pausedReason === "out_of_office";
  if (enrollments.some(away)) {
    await holdForReply(personId, { at: reply.repliedAt });
    actions.push("pause_held_again");
  }
  const targets = await heldEnrollments(personId);
  const enrollmentIds = targets.map((target) => target.id);
  if (targets.length > 0) {
    await tenantClient.enrollment.updateMany({
      where: { id: { in: enrollmentIds } },
      data: { replyLabel: reply.label, replyLabelAt: reply.repliedAt },
    });
    actions.push("label_recorded");
  }
  actions.push(...(await act(personId, reply, targets)));
  return { actions, enrollmentIds };
}

/** The label's own action on the targets, the newest first (the file's header). */
async function act(
  personId: string,
  reply: Reply,
  targets: readonly Target[],
): Promise<ReplyAction[]> {
  const [newest] = targets;
  const label: ReplyActionLabel = reply.label;
  if (label === "opt_out") {
    await addOptOut(personId, REPLY_OPT_OUT);
    return (await cancelHeld(personId, "opted_out"))
      ? ["opted_out", "steps_cancelled"]
      : ["opted_out"];
  }
  if (newest === undefined) return [];
  switch (label) {
    case "interested": {
      const { threadId, ownerUserId } = reply;
      const notice = { enrollmentId: newest.id, personId, kind: label, threadId, ownerUserId };
      const { workspaceId } = currentTenant();
      await publish(
        outboxWriter(tenantClient, workspaceId),
        events["campaigns.reply_notice_due"],
        notice,
      );
      return ["notice_published"];
    }
    case "not_now": {
      const remindAt = daysAfter(reply.repliedAt, settings.CAMPAIGNS_NOT_NOW_REMINDER_DAYS);
      await tenantClient.enrollment.updateMany({
        where: { id: newest.id },
        data: { remindAt, remindUserId: reply.ownerUserId, remindedAt: null },
      });
      return ["reminder_set"];
    }
    case "not_interested": {
      const cancelled = await cancelHeld(personId, "not_interested");
      const days = settings.CAMPAIGNS_NOT_INTERESTED_COOL_DOWN_DAYS;
      const coolDownUntil = daysAfter(reply.repliedAt, days);
      await tenantClient.enrollment.updateMany({
        where: { id: { in: targets.map((target) => target.id) } },
        data: { coolDownUntil },
      });
      return cancelled ? ["steps_cancelled", "cool_down_set"] : ["cool_down_set"];
    }
    case "out_of_office":
      return outOfOffice(newest, reply);
    default:
      // bounce, email's (the email phase), and other: the label alone; the person stays held.
      return [];
  }
}

/** The newest enrollment's hold released until the pause's end, then paused until it. */
async function outOfOffice(newest: Target, reply: Reply): Promise<ReplyAction[]> {
  const zone = newest.senderAccountId === null ? null : await timeZoneOf(newest.senderAccountId);
  const until = outOfOfficeUntil({
    returnDate: reply.returnDate,
    repliedAt: reply.repliedAt,
    timeZone: zone ?? OOO_FALLBACK_ZONE,
  });
  const released = await releaseHold(newest.id, { at: reply.repliedAt, firstDueAt: until });
  if (released !== "released") return [released];
  await pauseEnrollment(newest.id, { until, reason: "out_of_office" });
  return ["released", "paused"];
}

/** Every held step of the person `cancelled` with the reason, its items blocked: whether any was. */
async function cancelHeld(
  personId: string,
  code: "opted_out" | "not_interested",
): Promise<boolean> {
  const skipReason = checkedCode(STEP_REASON_CODES, "skip_reason", code);
  const cancelled = await tenantClient.stepExecution.updateManyAndReturn({
    where: { personId, status: "held" },
    data: { status: "cancelled", skipReason },
    select: { id: true },
  });
  await cancelItems(cancelled.map((step) => step.id));
  return cancelled.length > 0;
}

/** The lead, then each of the person's enrollments, locked; the enrollments read under the locks. */
async function lockEnrollments(personId: string) {
  await lockLeadStatus(personId);
  const found = await tenantClient.enrollment.findMany({
    where: { personId },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  for (const { id: enrollmentId } of found) await lockEnrollment(tenantClient, enrollmentId);
  return tenantClient.enrollment.findMany({
    where: { personId },
    select: { status: true, pausedReason: true, replyLabel: true, replyLabelAt: true },
  });
}

/** The person's `replied` enrollments that still have `held` steps, the newest first. */
async function heldEnrollments(personId: string): Promise<Target[]> {
  const replied = await tenantClient.enrollment.findMany({
    where: { personId, status: "replied" },
    select: { id: true, senderAccountId: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (replied.length === 0) return [];
  // The steps in a query of their own: the tenant client refuses a relation in a query.
  const held = await tenantClient.stepExecution.findMany({
    where: { enrollmentId: { in: replied.map((enrollment) => enrollment.id) }, status: "held" },
    select: { enrollmentId: true },
  });
  const holding = new Set(held.map((step) => step.enrollmentId));
  return replied.filter((enrollment) => holding.has(enrollment.id));
}

/** The input checked; an error naming its fields at fault, never their values. */
function parse(input: ReplyLabelInput): Reply {
  const parsed = labelInput.safeParse(input);
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "input")));
    throw new Error(`applyReplyLabel: ${[...fields].join(", ")} off its rule`);
  }
  requireInstant(parsed.data.repliedAt, "repliedAt");
  return parsed.data;
}

const daysAfter = (at: Date, days: number): Date => new Date(at.getTime() + days * MS_PER_DAY);
