"use client";
// The lead's Re-score (README "Screen"), in the lead page's header. A lead without a scored snapshot
// has a short note instead, which says what comes next: pending waits for the next batch, ai_failed
// for a change to the ICP's targeting. A scored one has Re-score, with what to do first when it needs
// review: the worker scores it again from its verdicts with the saved criteria. When the request
// marked the lead, its snapshot is asked for every two seconds, thirty seconds at most, until a new
// one takes the lead: its status shows and the page reads its data again. A failure shows its code
// in words, with a retry.
import { Button, ErrorState, LoadingState } from "@whytide/ui";
import { Info, RotateCw, TriangleAlert } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

/** What the panel shows of the lead: its status, why it waits or failed, its current snapshot. */
type Lead = {
  readonly status: string;
  readonly reason: string | null;
  readonly snapshotId: string | null;
};
type Failure = { readonly module: string; readonly code: string };
type Props = { workspaceId: string; personId: string; lead?: Lead; failure?: Failure };
/** Re-score's step: ready, waiting for a snapshot other than `from` (`left` polls more), or done. */
type Step =
  | { readonly kind: "ready" | "unchanged" | "waiting" }
  | { readonly kind: "running"; readonly from: string | null; readonly left: number }
  | { readonly kind: "rescored"; readonly status: string }
  | { readonly kind: "failed"; readonly failure: Failure };

const POLL_MS = 2_000;
const POLLS = 15;
const SCORED = new Set(["qualified", "not_qualified", "needs_review"]);
/** A note in place of the button or under it, its icon first: short, quiet, as the header's facts are. */
const NOTE = "flex max-w-xs items-start gap-1.5 text-start text-xs text-ink-muted";
const NOTE_ICON = "mt-px size-3.5 shrink-0";
const failed = (error: unknown): Step => {
  const code = error instanceof ApiError ? error.code : "internal_error";
  return { kind: "failed", failure: { module: "qualification", code } };
};

export function RescoreAction({ workspaceId, personId, lead, failure }: Props) {
  const t = useTranslations("qualification");
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: "ready" });

  async function rescore() {
    setStep({ kind: "running", from: lead?.snapshotId ?? null, left: POLLS });
    try {
      // One key per press: a retry of this request is answered once (core/apps/api "Request protection").
      const header = { "Idempotency-Key": crypto.randomUUID() };
      const { marked } = await data(
        browserApi().POST("/v1/workspaces/{workspaceId}/qualification/rescore", {
          params: { path: { workspaceId }, header },
          body: { personIds: [personId] },
        }),
      );
      if (marked === 0) setStep({ kind: "unchanged" });
    } catch (error) {
      setStep(failed(error));
    }
  }

  useEffect(() => {
    if (step.kind !== "running") return;
    if (step.left === 0) {
      setStep({ kind: "waiting" });
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const snapshot = await data(
          browserApi().GET("/v1/workspaces/{workspaceId}/qualification/leads/{personId}/snapshot", {
            params: { path: { workspaceId, personId } },
          }),
        );
        if (snapshot.snapshotId === step.from) {
          setStep((now) => (now.kind === "running" ? { ...now, left: now.left - 1 } : now));
          return;
        }
        setStep({ kind: "rescored", status: snapshot.status });
        router.refresh();
      } catch (error) {
        setStep(failed(error));
      }
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [step, workspaceId, personId, router]);

  if (failure !== undefined) {
    return (
      <ErrorState module={failure.module} code={failure.code} onRetry={() => router.refresh()} />
    );
  }
  if (step.kind === "failed") {
    const { module, code } = step.failure;
    return <ErrorState module={module} code={code} onRetry={rescore} />;
  }
  if (lead === undefined || lead.snapshotId === null || !SCORED.has(lead.status)) {
    const reason = lead?.reason ?? "none";
    const why =
      lead?.status === "pending"
        ? t("explain.pending", { reason })
        : lead?.status === "ai_failed"
          ? t("explain.ai_failed", { reason })
          : t("action.empty");
    return (
      <p className={NOTE}>
        <Info aria-hidden="true" className={NOTE_ICON} />
        {why}
      </p>
    );
  }
  const running = step.kind === "running";
  const said =
    step.kind === "rescored"
      ? t("action.rescored", { status: step.status })
      : step.kind === "unchanged"
        ? t("action.unchanged")
        : step.kind === "waiting"
          ? t("action.waiting")
          : undefined;
  return (
    <div className="grid justify-items-start gap-2 sm:justify-items-end">
      <Button onClick={rescore} loading={running}>
        {running ? null : <RotateCw aria-hidden="true" />}
        {t("action.rescore")}
      </Button>
      {lead.status === "needs_review" ? (
        <p className={NOTE}>
          <TriangleAlert aria-hidden="true" className={`${NOTE_ICON} text-warm-dot`} />
          {t("explain.needs_review")}
        </p>
      ) : null}
      {running ? (
        <div className="text-xs">
          <LoadingState />
        </div>
      ) : null}
      {said ? (
        <p role="status" className="max-w-xs text-xs text-ink-muted sm:text-end">
          {said}
        </p>
      ) : null}
    </div>
  );
}
