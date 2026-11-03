// The review panel in the browser (panel.tsx): Good lead with the tester's words, or Not a fit with
// one of the fifteen reasons and words for Other, then Confirm, which posts POST
// …/contacts/leads/{personId}/review; the decision becomes the latest and heads the history, with
// no reload. A refused decision shows its code's words on the field at fault, any other failure
// below.
"use client";

import { Button, Select, TextArea, useErrorText } from "@whytide/ui";
import { ThumbsDown, ThumbsUp } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import type { Review } from "./panel.tsx";
import { useReasonText } from "./reasons.ts";

type Decision = Review["decision"];
type Code = NonNullable<Review["reasonCode"]>;
type Props = { workspace: string; personId: string; history: Review[] };

/** The codes whose words go on a field rather than under the form. */
const FIELD_CODES = ["review_reason_required", "review_text_required"];

export function ReviewForm({ workspace, personId, history: first }: Props) {
  const t = useTranslations("contacts.review");
  const format = useFormatter();
  const [history, setHistory] = useState(first);
  const [choice, setChoice] = useState<Decision>();
  const [reasonCode, setReasonCode] = useState<Code | "">("");
  const [reasonText, setReasonText] = useState("");
  const [goodReasonText, setGoodReasonText] = useState("");
  const [failed, setFailed] = useState<string>();
  const [busy, setBusy] = useState(false);
  const failure = useErrorText("contacts", failed ?? "internal_error");

  const decisionText: Record<Decision, string> = {
    good_lead: t("good_lead"),
    not_a_fit: t("not_a_fit"),
  };
  const codeText = useReasonText();
  const codes = Object.keys(codeText) as Code[];
  const errorOn = (code: string) => (failed === code ? failure : undefined);
  const choose = (decision: Decision) => {
    setChoice(decision);
    setFailed(undefined);
  };

  async function confirm() {
    if (choice === undefined) return;
    const body =
      choice === "good_lead"
        ? { decision: choice, goodReasonText: goodReasonText.trim() || undefined }
        : {
            decision: choice,
            reasonCode: reasonCode || undefined,
            reasonText: reasonText.trim() || undefined,
          };
    const path = { workspaceId: workspace, personId };
    setBusy(true);
    try {
      const review = await data(
        browserApi().POST("/v1/workspaces/{workspaceId}/contacts/leads/{personId}/review", {
          params: { path },
          body,
        }),
      );
      setHistory((reviews) => [review, ...reviews]);
      setChoice(undefined);
      setReasonCode("");
      setReasonText("");
      setGoodReasonText("");
      setFailed(undefined);
    } catch (error) {
      setFailed(error instanceof ApiError ? error.code : "internal_error");
    } finally {
      setBusy(false);
    }
  }

  /** A decision in words: its kind with its reason, the tester's text and when. */
  const describe = ({ decision, reasonCode, decidedAt, ...review }: Review) => {
    const label = reasonCode
      ? t("not_a_fit_because", { reason: codeText[reasonCode] })
      : decisionText[decision];
    const words = review.reasonText ?? review.goodReasonText;
    const at = format.dateTime(new Date(decidedAt), { dateStyle: "medium", timeStyle: "short" });
    return (
      <>
        <strong className="font-semibold text-ink">{label}</strong>
        {words && (
          <>
            {" "}
            <q className="text-ink-muted">{words}</q>
          </>
        )}{" "}
        <time dateTime={decidedAt} className="mt-0.5 block text-xs text-ink-muted">
          {at}
        </time>
      </>
    );
  };
  const [latest] = history;

  return (
    <section
      aria-labelledby="lead-review"
      className="grid content-start gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs [&_.wt-field]:min-w-0"
    >
      <h2 id="lead-review" className="font-semibold text-ink">
        {t("title")}
      </h2>
      <dl className="grid gap-1 rounded-lg bg-muted px-3 py-2.5">
        <dt className="text-xs font-medium text-ink-muted">{t("latest")}</dt>
        <dd className="text-ink-muted">{latest ? describe(latest) : t("none")}</dd>
      </dl>
      <div className="grid grid-cols-2 gap-2">
        <Button aria-pressed={choice === "good_lead"} onClick={() => choose("good_lead")}>
          <ThumbsUp aria-hidden="true" />
          {t("good_lead")}
        </Button>
        <Button aria-pressed={choice === "not_a_fit"} onClick={() => choose("not_a_fit")}>
          <ThumbsDown aria-hidden="true" />
          {t("not_a_fit")}
        </Button>
      </div>
      {choice === "not_a_fit" && (
        <>
          <Select
            label={t("reason")}
            value={reasonCode}
            options={[
              { value: "", label: t("reason_choose") },
              ...codes.map((code) => ({ value: code, label: codeText[code] })),
            ]}
            error={errorOn("review_reason_required")}
            onChange={(event) => setReasonCode(event.target.value as Code | "")}
          />
          <TextArea
            label={t("reason_text")}
            maxLength={500}
            value={reasonText}
            error={errorOn("review_text_required")}
            onChange={(event) => setReasonText(event.target.value)}
          />
        </>
      )}
      {choice === "good_lead" && (
        <TextArea
          label={t("good_reason_text")}
          maxLength={200}
          value={goodReasonText}
          error={errorOn("review_text_required")}
          onChange={(event) => setGoodReasonText(event.target.value)}
        />
      )}
      {choice && (
        <Button variant="primary" loading={busy} onClick={confirm}>
          {t("confirm")}
        </Button>
      )}
      {failed && !FIELD_CODES.includes(failed) && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-danger-ink">
          {failure}
        </p>
      )}
      {history.length > 0 && (
        <div className="grid gap-3 border-t border-line pt-4">
          <h3 className="text-sm font-semibold text-ink">{t("history")}</h3>
          <ol className="grid gap-3.5">
            {history.map((review) => (
              <li
                key={review.id}
                className="relative ps-5 text-sm text-ink-muted before:absolute before:start-0 before:top-1.5 before:size-2 before:rounded-full before:bg-line-strong first:before:bg-accent"
              >
                {describe(review)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
