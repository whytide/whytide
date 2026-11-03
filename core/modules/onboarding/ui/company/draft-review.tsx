// The draft review (README "The screen"), a client component of the Company Knowledge form: each
// drafted field, the record's value now beside the draft's on a wide screen, each drafted value with
// a link to its page or its document's name, never a link (README "The documents"), "Replace my
// edits", Discard and Accept; a draft with nothing in it says so, with Discard alone; a failed Accept
// or Discard shows its code in words with a retry. Nothing of the draft reaches the record before
// Accept.
"use client";

import { Badge, Button, Checkbox, EmptyState, ErrorState, Link } from "@whytide/ui";
import { ExternalLink, Sparkles } from "@whytide/ui/icons";
import { browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { documentName } from "../../domain/documents.ts";
import { CONTENT_FIELDS, type ContentField } from "../../domain/fields.ts";
import type { CompanyKnowledgeResponse } from "../../schemas/company-knowledge.ts";
import type { Cited, PendingDraft } from "../../schemas/draft-company-knowledge.ts";
import { codeOf, type Problem } from "./problem.ts";

type Knowledge = CompanyKnowledgeResponse;
type Busy = "accept" | "discard";
type Props = {
  workspace: string;
  record: Knowledge;
  draft: PendingDraft;
  /** The record after an accept: its fields replace the form's. */
  onAccepted: (record: Knowledge) => void;
  /** The record after a discard: the form stays as it is. */
  onDiscarded: (record: Knowledge) => void;
};

const PATH = "/v1/workspaces/{workspaceId}/onboarding/company-knowledge";
/** The small word over each side of a field: now, and the draft. */
const SIDE = "text-xs font-medium text-ink-muted";

/** A field's drafted values, a text field's one or a list's items; none when the draft has none. */
function draftedOf(draft: PendingDraft, field: ContentField): Cited[] {
  const value = draft.fields[field];
  if (value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** A field's values in the record, a text field's one when it is not empty. */
function currentOf(record: Knowledge, field: ContentField): string[] {
  if (field === "proofPoints") return record.proofPoints.map((point) => point.text);
  const value = record[field];
  if (typeof value !== "string") return value;
  return value === "" ? [] : [value];
}

export function DraftReview({ workspace, record, draft, onAccepted, onDiscarded }: Props) {
  const t = useTranslations("onboarding");
  const [replaceEdited, setReplaceEdited] = useState(false);
  const [busy, setBusy] = useState<Busy>();
  const [problem, setProblem] = useState<Problem>();
  const labels: { [F in ContentField]: string } = {
    oneLiner: t("company.one_liner"),
    longDescription: t("company.long_description"),
    products: t("company.products"),
    painPoints: t("company.pain_points"),
    featuresBenefits: t("company.features_benefits"),
    proofPoints: t("company.proof_points"),
    competitors: t("company.competitors"),
    tone: t("company.tone"),
  };
  const fields = CONTENT_FIELDS.filter((field) => draftedOf(draft, field).length > 0);

  /**
   * Accepts or discards. One key per press, and a retry sends the press's key and body again, so
   * that the api runs a repeat once (core/apps/api "Request protection").
   */
  async function decide(action: Busy, key = crypto.randomUUID(), replace = replaceEdited) {
    setBusy(action);
    setProblem(undefined);
    let code = "internal_error";
    try {
      const params = { path: { workspaceId: workspace }, header: { "Idempotency-Key": key } };
      const api = browserApi();
      if (action === "discard") {
        return onDiscarded(await data(api.POST(`${PATH}/draft/discard`, { params })));
      }
      const body = { replaceEdited: replace };
      return onAccepted(await data(api.POST(`${PATH}/draft/accept`, { params, body })));
    } catch (error) {
      code = codeOf(error);
    } finally {
      setBusy(undefined);
    }
    // Once the draft is gone, a retry cannot help.
    const retry =
      code === "company_knowledge_no_draft" ? undefined : () => decide(action, key, replace);
    setProblem({ code, retry });
  }

  return (
    <section
      data-part="draft-review"
      aria-labelledby="draft-review-title"
      className="grid gap-5 rounded-xl border border-accent/35 bg-surface p-5 shadow-sm ring-4 ring-accent-soft"
    >
      <header className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink">
          <Sparkles aria-hidden="true" className="size-4.5" />
        </span>
        <h2 id="draft-review-title" className="text-balance font-semibold text-ink">
          {t("company.draft_ready")}
        </h2>
      </header>
      {fields.length === 0 ? (
        <EmptyState message={t("company.review.empty")} />
      ) : (
        <ul className="grid gap-3">
          {fields.map((field) => (
            <li
              key={field}
              data-review-field={field}
              className="grid gap-x-6 gap-y-3 rounded-lg border border-line p-4 md:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1fr)]"
            >
              <h3 className="font-medium text-ink">{labels[field]}</h3>
              <div data-side="current" className="grid content-start gap-1.5">
                <p className={SIDE}>{t("company.review.current")}</p>
                {currentOf(record, field).length === 0 ? (
                  <p className="text-ink-subtle">{t("company.review.blank")}</p>
                ) : (
                  <ul className="grid gap-1.5 text-ink">
                    {/* Keyed by place and text, so two equal items keep apart: the lists never reorder. */}
                    {currentOf(record, field).map((value, at) => (
                      <li key={`${at}:${value}`} className="text-pretty">
                        {value}
                      </li>
                    ))}
                  </ul>
                )}
                {record.fieldSources[field]?.kind === "human" ? (
                  <p className="my-3">
                    <Badge>{t("company.source.human")}</Badge>
                  </p>
                ) : null}
              </div>
              <div
                data-side="draft"
                className="grid content-start gap-1.5 rounded-md bg-accent-soft px-3 py-2.5"
              >
                <p className="text-xs font-medium text-accent-ink">{t("company.review.draft")}</p>
                <ul className="grid gap-1.5 text-ink">
                  {draftedOf(draft, field).map((item, at) => {
                    const fromDocument = documentName(item.sourceUrl);
                    return (
                      <li key={`${at}:${item.text}`} className="text-pretty">
                        {item.text}{" "}
                        {fromDocument !== null ? (
                          <span data-source="document" className="text-xs text-ink-muted">
                            {t("company.source.document", { name: fromDocument })}
                          </span>
                        ) : /^https?:\/\//i.test(item.sourceUrl) ? (
                          <span className="whitespace-nowrap text-xs">
                            <Link href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
                              {t("company.source.page")}
                              <ExternalLink
                                aria-hidden="true"
                                className="ms-1 inline size-3 align-[-0.125em] rtl:-scale-x-100"
                              />
                            </Link>
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        {fields.length > 0 ? (
          <Checkbox
            label={t("company.replace_edited")}
            checked={replaceEdited}
            onChange={(event) => setReplaceEdited(event.target.checked)}
          />
        ) : null}
        <div className="ms-auto flex flex-wrap gap-2">
          <Button loading={busy === "discard"} onClick={() => decide("discard")}>
            {t("company.discard")}
          </Button>
          {fields.length > 0 ? (
            <Button variant="primary" loading={busy === "accept"} onClick={() => decide("accept")}>
              {t("company.accept")}
            </Button>
          ) : null}
        </div>
      </div>
      {problem ? (
        <ErrorState module="onboarding" code={problem.code} onRetry={problem.retry} />
      ) : null}
    </section>
  );
}
