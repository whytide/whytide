// The Company Knowledge screen in the browser (page.tsx; README "The screen"): the record read here, so
// that its loading state shows, the form's cards as skeletons, and its error state, the code in words
// with a retry; then the form, which holds the record from there on.
"use client";

import { ErrorState, LoadingState, Skeleton } from "@whytide/ui";
import { browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useState } from "react";
import type { CompanyKnowledgeResponse } from "../../schemas/company-knowledge.ts";
import { CompanyForm } from "./company-form.tsx";
import { SKELETON_CARDS, SKELETON_LINES } from "./constants.ts";
import { codeOf } from "./problem.ts";

const PATH = "/v1/workspaces/{workspaceId}/onboarding/company-knowledge";

export function CompanyScreen({ workspace }: { workspace: string }) {
  const t = useTranslations("onboarding.company");
  const id = useId();
  const [record, setRecord] = useState<CompanyKnowledgeResponse>();
  const [failure, setFailure] = useState<string>();

  /** The first read, and the retry: the loading state, then the record or the failure. */
  const load = useCallback(async () => {
    setFailure(undefined);
    setRecord(undefined);
    try {
      const params = { path: { workspaceId: workspace } };
      setRecord(await data(browserApi().GET(PATH, { params })));
    } catch (error) {
      setFailure(codeOf(error));
    }
  }, [workspace]);
  useEffect(() => {
    void load();
  }, [load]);

  if (failure !== undefined) {
    return (
      <section aria-labelledby={`${id}-error`} className="grid gap-3">
        <h2 id={`${id}-error`} className="font-semibold text-ink">
          {t("error")}
        </h2>
        <ErrorState module="onboarding" code={failure} onRetry={load} />
      </section>
    );
  }
  if (record === undefined) {
    return (
      <section aria-label={t("loading")} aria-busy="true" className="grid gap-6">
        <LoadingState />
        <div className="grid gap-6 xl:grid-cols-2">
          {SKELETON_CARDS.map((card) => (
            <div key={card} className="rounded-xl border border-line bg-surface p-5 shadow-xs">
              <Skeleton lines={SKELETON_LINES} />
            </div>
          ))}
        </div>
      </section>
    );
  }
  return <CompanyForm workspace={workspace} initial={record} />;
}
