// Approve (README.md "Screens"), on the lead page's header (view.tsx) and in the list's row menu
// (../leads/list.tsx): one press moves the lead to approved, POST …/contacts/leads/{personId}/approve,
// and the screen's toast confirms it. One Idempotency-Key per press, which its retry sends again, as messaging's
// draft panel does: the api acts on a press once. A lead a campaign has, or had, offers no Approve.
// A refusal is shown in words; person_suppressed with the check's reason, and a recent touch with
// the days the api's refusal answers (`details.days`, the setting's), never a number of its own.
"use client";

import { Button, ErrorState, Link } from "@whytide/ui";
import { CircleAlert, CircleCheck } from "@whytide/ui/icons";
import { ApiError, browserApi } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { IN_OUTREACH } from "../../domain/outreach/constants.ts";
import { SUPPRESSION_REASONS } from "../../domain/suppression/constants.ts";
import type { Lead } from "./page.tsx";

type Outreach = Lead["outreachStatus"];
/** A press that failed: its code, the check's reason and days for person_suppressed, and its retry. */
export type ApproveFailure = {
  readonly personId: string;
  readonly code: string;
  readonly reason?: string;
  /** A recent touch's days, as the api answers them. */
  readonly days?: number;
  readonly retry: () => void;
};

/** Whether Approve is offered: not once a campaign has the lead, or had it. */
export const canApprove = (status: Outreach) =>
  !(IN_OUTREACH as readonly Outreach[]).includes(status);

/**
 * Approve's presses on a screen: the person being approved and the last failure; `onDone` takes
 * the lead's new status and the name the press gave, for the screen's toast.
 */
export function useApprove(
  workspace: string,
  onDone: (personId: string, to: Outreach, name: string) => void,
) {
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<ApproveFailure>();

  async function approve(personId: string, name: string, key = crypto.randomUUID()) {
    const retry = () => void approve(personId, name, key);
    setBusy(personId);
    setFailure(undefined);
    try {
      const path = { workspaceId: workspace, personId };
      const header = { "Idempotency-Key": key };
      const answer = await browserApi().POST(
        "/v1/workspaces/{workspaceId}/contacts/leads/{personId}/approve",
        { params: { path, header } },
      );
      if (!answer.response.ok || answer.data === undefined) {
        const { code } = new ApiError(answer.response.status, answer.error);
        const error = answer.error as
          | { details?: { reason?: unknown; days?: unknown } }
          | undefined;
        const given = error?.details;
        const days = typeof given?.days === "number" ? given.days : undefined;
        const known = SUPPRESSION_REASONS.find((reason) => reason === given?.reason);
        // Without the days, a recent touch reads as the check's generic refusal.
        const reason = known === "recently_contacted" && days === undefined ? undefined : known;
        setFailure({ personId, code, reason, days, retry });
        return;
      }
      onDone(personId, answer.data.outreachStatus, name);
    } catch {
      setFailure({ personId, code: "internal_error", retry });
    } finally {
      setBusy(undefined);
    }
  }

  return { approve, busy, failure };
}

/**
 * The header's Approve, "Approve again" on an approved lead; disabled, with the way to connect one,
 * while the user has no connected LinkedIn account.
 */
export function ApproveButton(props: {
  workspace: string;
  status: Outreach;
  hasSender: boolean;
  busy: boolean;
  onApprove: () => void;
}) {
  const { workspace, status, hasSender, busy, onApprove } = props;
  const t = useTranslations("contacts.approve");
  const hint = useId();
  return (
    <div className="grid justify-items-start gap-1.5 sm:justify-items-end">
      <Button
        variant="primary"
        onClick={onApprove}
        loading={busy}
        disabled={!hasSender}
        aria-describedby={hasSender ? undefined : hint}
      >
        <CircleCheck aria-hidden="true" />
        {status === "approved" ? t("again") : t("action")}
      </Button>
      {!hasSender && (
        <p id={hint} className="max-w-64 text-xs text-ink-muted sm:text-end">
          {t.rich("no_sender", {
            link: (chunks) => <Link href={`/w/${workspace}/linkedin`}>{chunks}</Link>,
          })}
        </p>
      )}
    </div>
  );
}

/** A press that failed, in words: the check's reason for person_suppressed; a retry where one helps. */
export function ApproveFailed({ failure }: { failure: ApproveFailure }) {
  const t = useTranslations("contacts.approve");
  const errors = useTranslations("contacts.errors");
  if (failure.code === "person_suppressed") {
    return (
      <div role="alert" className="wt-error-state">
        <strong className="flex items-center gap-2 font-semibold text-danger-ink">
          <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
          {errors("person_suppressed")}
        </strong>
        <p className="text-ink-muted">
          {/* Only a recent touch reads the days, and it always carries them (useApprove). */}
          {t("suppressed", { reason: failure.reason ?? "other", days: failure.days ?? 0 })}
        </p>
      </div>
    );
  }
  const final = failure.code === "lead_in_outreach" || failure.code === "lead_not_found";
  return (
    <ErrorState module="contacts" code={failure.code} onRetry={final ? undefined : failure.retry} />
  );
}
