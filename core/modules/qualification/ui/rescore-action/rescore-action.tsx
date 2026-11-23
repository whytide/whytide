"use client";
// The lead's Re-score (README "Screen", "A new assessment"), in the lead page's header. Every decided
// lead has it, whatever its status, with one line under it: it asks the AI to assess the lead again
// with its details of now, for one assessment's credits; a lead that needs review says what to check,
// an ai_failed one why the AI failed. A pending lead has a short note instead, which says what it
// waits for. After the press, the lead is read every few seconds while it waits for the member's
// request, about three minutes at most: then its new status shows, or the note of what it waits for
// now (credits, the provider), and the page reads its data again; past that, a line says the result
// shows when the AI is done. A failure shows its code in words, with a retry.
import { Button, ErrorState, LoadingState } from "@whytide/ui";
import { Info, RotateCw, TriangleAlert } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { MEMBER_REQUESTED } from "../../domain/member-reassess/constants.ts";
import { POLL_LIMIT, POLL_MS } from "./constants.ts";

/** What the panel shows of the lead: its status, and why it waits or failed. */
type Lead = { readonly status: string; readonly reason: string | null };
type Failure = { readonly module: string; readonly code: string };
type Props = { workspaceId: string; personId: string; lead?: Lead; failure?: Failure };
/** Re-score's step: ready, asking, reading the lead until it leaves pending (`left` reads more), or done. */
type Step =
  | { readonly kind: "ready" | "asking" | "waiting" }
  | { readonly kind: "reading"; readonly left: number }
  | { readonly kind: "rescored"; readonly status: string }
  | { readonly kind: "failed"; readonly failure: Failure };

/** A line under the button, quiet, as the header's facts are. */
const LINE = "max-w-xs text-start text-xs text-ink-muted sm:text-end";
/** A note in place of the button or under it, its icon first. */
const NOTE = "flex max-w-xs items-start gap-1.5 text-start text-xs text-ink-muted";
const NOTE_ICON = "mt-px size-3.5 shrink-0";
const failed = (error: unknown, module: string): Step => {
  const code = error instanceof ApiError ? error.code : "internal_error";
  return { kind: "failed", failure: { module, code } };
};

export function RescoreAction({ workspaceId, personId, lead, failure }: Props) {
  const t = useTranslations("qualification");
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: "ready" });

  async function reassess() {
    setStep({ kind: "asking" });
    try {
      // One key per press: a retry of this request is answered once (core/apps/api "Request protection").
      const header = { "Idempotency-Key": crypto.randomUUID() };
      await data(
        browserApi().POST("/v1/workspaces/{workspaceId}/qualification/leads/{personId}/reassess", {
          params: { path: { workspaceId, personId }, header },
        }),
      );
      setStep({ kind: "reading", left: POLL_LIMIT });
    } catch (error) {
      setStep(failed(error, "qualification"));
    }
  }

  useEffect(() => {
    if (step.kind !== "reading") return;
    if (step.left === 0) {
      setStep({ kind: "waiting" });
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const read = await data(
          browserApi().GET("/v1/workspaces/{workspaceId}/contacts/leads/{personId}", {
            params: { path: { workspaceId, personId } },
          }),
        );
        const status = read.qualificationStatus;
        if (status === "pending" && read.statusReason === MEMBER_REQUESTED) {
          setStep((now) => (now.kind === "reading" ? { ...now, left: now.left - 1 } : now));
          return;
        }
        // Decided, or waiting for something else now: the page's new read shows its note.
        setStep(status === "pending" ? { kind: "ready" } : { kind: "rescored", status });
        router.refresh();
      } catch (error) {
        setStep(failed(error, "contacts"));
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
    return <ErrorState module={module} code={code} onRetry={reassess} />;
  }
  const reason = lead?.reason ?? "none";
  if (lead === undefined || lead.status === "pending") {
    return (
      <p className={NOTE}>
        <Info aria-hidden="true" className={NOTE_ICON} />
        {t("explain.pending", { reason })}
      </p>
    );
  }
  const busy = step.kind === "asking" || step.kind === "reading";
  const said =
    step.kind === "rescored"
      ? t("action.rescored", { status: step.status })
      : step.kind === "waiting"
        ? t("action.waiting")
        : undefined;
  return (
    <div className="grid justify-items-start gap-2 sm:justify-items-end">
      <Button onClick={reassess} loading={busy}>
        {busy ? null : <RotateCw aria-hidden="true" />}
        {t("action.rescore")}
      </Button>
      <p className={LINE}>{t("action.rescore_hint")}</p>
      {lead.status === "needs_review" ? (
        <p className={NOTE}>
          <TriangleAlert aria-hidden="true" className={`${NOTE_ICON} text-warm-dot`} />
          {t("explain.needs_review")}
        </p>
      ) : null}
      {lead.status === "ai_failed" ? (
        <p className={NOTE}>
          <Info aria-hidden="true" className={NOTE_ICON} />
          {t("explain.ai_failed", { reason })}
        </p>
      ) : null}
      {busy ? (
        <div className="text-xs">
          <LoadingState />
        </div>
      ) : null}
      {said ? (
        <p role="status" className={LINE}>
          {said}
        </p>
      ) : null}
    </div>
  );
}
