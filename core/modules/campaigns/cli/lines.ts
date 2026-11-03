// The report's lines (README.md "Commands"), pure: every workspace's figures, added up or listed, in
// the command's order, each line `<code>: <detail>` with ids, codes, counts, days and instants only;
// and whether the three zeros hold.
import { acceptanceShare } from "../domain/report/acceptance.ts";
import type { Violation } from "../domain/report/approval.ts";
import { editShare } from "../domain/report/edits.ts";
import type { WorkspaceReport } from "../domain/report/report.ts";
import { LINE, NO_SHARE, NO_STEP, SENDER_SPAN_DAYS, SHARE_DECIMALS, TARGETS } from "./constants.ts";

/** A health event's state, and the line that counts it. */
const WARNINGS = [
  ["restricted", LINE.restrictions],
  ["checkpoint", LINE.checkpoints],
] as const;

/** The lines of the reports, in the order of the workspaces given (the file's header). */
export function reportLines(reports: readonly WorkspaceReport[]): string[] {
  const lines: string[] = [];
  const each = <T>(pick: (report: WorkspaceReport) => readonly T[]) =>
    reports.flatMap((report) => pick(report).map((item) => ({ ...item, wsp: report.workspaceId })));
  const zero = (code: string, found: readonly (Violation & { wsp: string })[]) => {
    lines.push(`${code}: ${found.length}`);
    for (const { wsp, stepExecutionId, reason, at } of found) {
      lines.push(
        `${LINE.violation}: ${code} ${wsp} ${stepExecutionId} ${reason} ${at.toISOString()}`,
      );
    }
  };

  zero(
    LINE.sendsWithoutApproval,
    each(({ withoutApproval }) => withoutApproval),
  );
  const missing = each(({ missing }) => missing);
  lines.push(`${LINE.sendStepMissing}: ${missing.length}`);
  for (const { wsp, id, stepExecutionId, senderAccountId, kind, at } of missing) {
    const step = stepExecutionId ?? NO_STEP;
    lines.push(
      `${LINE.missingStep}: ${wsp} ${id} ${step} ${senderAccountId} ${kind} ${at.toISOString()}`,
    );
  }
  zero(
    LINE.actionsAgainstSuppressed,
    each(({ suppressed }) => suppressed),
  );
  const duplicates = each(({ duplicates }) => duplicates);
  lines.push(`${LINE.duplicateSends}: ${duplicates.length}`);
  for (const { wsp, stepExecutionId, rows } of duplicates) {
    lines.push(
      `${LINE.violation}: ${LINE.duplicateSends} ${wsp} ${stepExecutionId} ${rows.join(",")}`,
    );
  }

  const edits = { approved: 0, unedited: 0, smallEdits: 0 };
  for (const { approved, unedited, smallEdits } of reports.map(({ edits }) => edits)) {
    edits.approved += approved;
    edits.unedited += unedited;
    edits.smallEdits += smallEdits;
  }
  const counted = `approved=${edits.approved} unedited=${edits.unedited} small_edits=${edits.smallEdits}`;
  lines.push(
    `${LINE.draftsSmallEdits}: ${share(editShare(edits))} ${counted} target=${TARGETS.smallEdits}`,
  );

  const senders = each(({ acceptance }) => acceptance);
  const sent = senders.reduce((total, { sent }) => total + sent, 0);
  const accepted = senders.reduce((total, { accepted }) => total + accepted, 0);
  const rate = share(acceptanceShare({ sent, accepted }));
  lines.push(
    `${LINE.acceptanceRate}: ${rate} sent=${sent} accepted=${accepted} target=${TARGETS.acceptance}`,
  );
  for (const sender of senders) {
    const line = `${sender.wsp} ${sender.senderAccountId} ${share(acceptanceShare(sender))}`;
    lines.push(`${LINE.acceptanceRateSender}: ${line}`);
  }

  const spans = each(({ spans }) => spans);
  const long = spans.filter(({ days }) => days >= SENDER_SPAN_DAYS).length;
  lines.push(`${LINE.sendersThreeWeeks}: ${long} target=${TARGETS.senders}`);
  for (const { wsp, senderAccountId, first, last, days } of spans) {
    lines.push(`${LINE.senderSpan}: ${wsp} ${senderAccountId} ${first} ${last} ${days}`);
  }

  const events = each(({ warnings }) => warnings);
  for (const [state, code] of WARNINGS) {
    const found = events.filter(({ toState }) => toState === state);
    lines.push(`${code}: ${found.length}`);
    for (const { wsp, senderAccountId, id, toState, trigger, createdAt } of found) {
      const event = `${wsp} ${senderAccountId} ${id} ${toState} ${trigger} ${createdAt.toISOString()}`;
      lines.push(`${LINE.healthEvent}: ${event}`);
    }
  }

  for (const { workspaceId, decisions } of reports) {
    lines.push(
      `${LINE.decisionDays}: ${workspaceId} ${decisions.decided} of ${decisions.weekdays}`,
    );
  }
  return lines;
}

/**
 * Whether every report holds the three zeros: no send without approval, none against suppression,
 * no duplicate.
 */
export const zerosHold = (reports: readonly WorkspaceReport[]): boolean =>
  reports.every(
    ({ withoutApproval, suppressed, duplicates }) =>
      withoutApproval.length === 0 && suppressed.length === 0 && duplicates.length === 0,
  );

const share = (value: number | null): string =>
  value === null ? NO_SHARE : value.toFixed(SHARE_DECIMALS);
