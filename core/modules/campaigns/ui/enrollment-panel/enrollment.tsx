// One enrollment in the panel (panel.tsx): its campaign's name and version, its status as a badge
// (Not started for one that exited as it was made) and, once it exited, why in words: its exit
// reason, then the suppression reason behind it; while paused, who paused it and when it resumes
// (gamma-p3-060). Pause, behind the kit's confirming Dialog, on an active one, and Resume on a
// paused one, through campaigns' routes (gamma-p3-061): one button, so the focus stays on it as
// one becomes the other; a refusal shows its code in words. Then its steps by position, each with
// its name, its status, its time in the sender's zone with the zone named, and why it was skipped,
// held or waits. The time is the send's once sent, else its slot, else when it falls due; a step
// still to come without one says what it waits for.
"use client";

import { Badge, Button, Dialog, ErrorState } from "@whytide/ui";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { PENDING_STEP_STATUSES } from "../../domain/gate/constants.ts";
import { TEMPLATE_STEPS } from "../../domain/template/constants.ts";
import type { EnrollmentsResponse } from "../../schemas/enrollments.ts";
import { ENROLLMENT_TONE, FALLBACK_ZONE, STEP_TONE, TIME_FORMAT } from "./constants.ts";
import { useEnrollmentWords } from "./words.ts";

type Shown = EnrollmentsResponse["enrollments"][number];
type Step = Shown["steps"][number];
type Move = "pause" | "resume";

export function Enrollment(props: {
  workspace: string;
  enrollment: Shown;
  /** After a pause or a resume, or its refusal by the api: the panel reads again. */
  onChanged: () => Promise<unknown>;
}) {
  const { workspace, enrollment, onChanged } = props;
  const { status, exitReason, exitDetail, startedAt, timeZone, steps } = enrollment;
  const t = useTranslations("campaigns.enrollment");
  const p = useTranslations("campaigns.panel");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const words = useEnrollmentWords();
  const format = useFormatter();
  const shown = status === "exited" && startedAt === null ? "refused" : status;
  const zone = timeZone ?? FALLBACK_ZONE;
  const at = (instant: string) => ({
    time: format.dateTime(new Date(instant), { ...TIME_FORMAT, timeZone: zone }),
    zone,
  });

  /** The step's time, its instant with it, or what a step still to come waits for. */
  const when = (step: Step): { text: string; instant?: string } | undefined => {
    const { executedAt, scheduledFor, dueAt } = step;
    if (executedAt) return { text: t("time.sent", at(executedAt)), instant: executedAt };
    if (scheduledFor) return { text: t("time.scheduled", at(scheduledFor)), instant: scheduledFor };
    if (dueAt) return { text: t("time.due", at(dueAt)), instant: dueAt };
    // Only a step not yet handed to the sender says what it waits for.
    if (!PENDING_STEP_STATUSES.some((pending) => pending === step.status)) return undefined;
    const anchor = TEMPLATE_STEPS.find(({ stepKey }) => stepKey === step.stepKey)?.delay.anchor;
    if (anchor === "accepted") return { text: t("time.after_acceptance") };
    if (anchor === "prev_step") return { text: t("time.after_previous") };
    return undefined;
  };

  /**
   * The pause or the resume through campaigns' route. A refusal's code stays shown in words, and the
   * panel reads again: the enrollment may have moved meanwhile, which is why it was refused.
   */
  async function move(to: Move) {
    setConfirming(false);
    setBusy(true);
    setFailed(undefined);
    const params = { path: { workspaceId: workspace, enrollmentId: enrollment.id } };
    try {
      if (to === "pause") {
        const path = "/v1/workspaces/{workspaceId}/campaigns/enrollments/{enrollmentId}/pause";
        await data(browserApi().POST(path, { params, body: {} }));
      } else {
        const path = "/v1/workspaces/{workspaceId}/campaigns/enrollments/{enrollmentId}/resume";
        await data(browserApi().POST(path, { params }));
      }
      await onChanged();
    } catch (error) {
      setFailed(error instanceof ApiError ? error.code : "internal_error");
      if (error instanceof ApiError) await onChanged();
    } finally {
      setBusy(false);
    }
  }

  const name = enrollment.campaignName || p("default_campaign");
  const paused = enrollment.pausedReason;
  return (
    <div data-part="enrollment" className="grid gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="grid gap-1">
          <p className="text-sm text-ink-muted">
            {p("campaign", { name, version: enrollment.templateVersion })}
          </p>
          <p className="flex">
            <Badge tone={ENROLLMENT_TONE[shown]}>{words.status[shown]}</Badge>
          </p>
        </div>
        {(status === "active" || status === "paused") && (
          <Button
            size="sm"
            loading={busy}
            onClick={() => (status === "active" ? setConfirming(true) : move("resume"))}
          >
            {status === "active" ? p("pause") : p("resume")}
          </Button>
        )}
      </div>
      {paused && (
        <p className="text-pretty text-ink-muted">
          {paused === "out_of_office" ? p("paused.out_of_office") : p("paused.user")}
          {enrollment.pausedUntil && ` ${p("paused_until", at(enrollment.pausedUntil))}`}
        </p>
      )}
      {failed && <ErrorState module="campaigns" code={failed} />}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={p("pause_title")}
        actions={
          <Button variant="primary" onClick={() => move("pause")}>
            {p("pause")}
          </Button>
        }
      >
        <p>{p("pause_body")}</p>
      </Dialog>
      {exitReason && (
        <p className="text-pretty text-ink-muted">
          {words.reason(exitReason)}
          {exitDetail && ` ${words.reason(exitDetail)}`}
        </p>
      )}
      {steps.length > 0 && (
        <ol aria-label={t("steps")} className="grid gap-3">
          {steps.map((step) => {
            const time = when(step);
            const reason = step.skipReason ?? step.errorCode;
            return (
              <li key={step.stepKey} className="grid gap-1">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="font-medium text-ink">{words.name(step.stepKey)}</span>
                  <Badge tone={STEP_TONE[step.status]}>{words.stepStatus[step.status]}</Badge>
                </div>
                {time && (
                  <p className="text-sm text-ink-muted">
                    {time.instant ? <time dateTime={time.instant}>{time.text}</time> : time.text}
                  </p>
                )}
                {reason && <p className="text-sm text-pretty text-ink">{words.reason(reason)}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
