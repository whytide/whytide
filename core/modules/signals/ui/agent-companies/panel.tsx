// signals' panel in the companies slot of playbooks' agent page (ui/nav.ts `panels`; README.md
// "Screens"; gamma-wr-111): the newest fitting companies of the agent's sources, five at most, each its
// name, site and place, read in the browser as the member through part 1's list route filtered by the
// agent, with a link to the Companies found screen with the agent chosen. While it reads, the slot's
// loading state; a failed read, the error state with the code in words and Try again; no fitting
// company yet, the empty state. Names and sites are the web's words, shown as text.
"use client";

import { ButtonLink, Card, EmptyState, ErrorState, LoadingState } from "@whytide/ui";
import { ArrowRight } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { FOUND_PANEL_COUNT } from "../../domain/research/constants.ts";
import type { FoundCompanyResponse } from "../../schemas/found-companies.ts";
import { FOUND_PATH, foundScreen } from "../found-companies/constants.ts";

type Read = { readonly companies: FoundCompanyResponse[] } | { readonly failed: string };
const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");

export default function AgentCompaniesPanel(props: { workspace: string; playbookId: string }) {
  const { workspace, playbookId } = props;
  const t = useTranslations("signals.agent_companies");
  const [read, setRead] = useState<Read>();
  /** Raised by Try again, which reads once more. */
  const [attempt, setAttempt] = useState(0);

  // One read per agent, workspace and attempt; an earlier one that answers late is dropped.
  useEffect(() => {
    let live = true;
    setRead(undefined);
    void attempt;
    const path = { workspaceId: workspace };
    const query = { playbookId, verdict: "fit", limit: FOUND_PANEL_COUNT } as const;
    data(browserApi().GET(FOUND_PATH, { params: { path, query } })).then(
      ({ companies }) => live && setRead({ companies }),
      (error: unknown) => live && setRead({ failed: codeOf(error) }),
    );
    return () => {
      live = false;
    };
  }, [workspace, playbookId, attempt]);

  if (read === undefined) return <LoadingState />;
  return (
    <Card title={t("title")} description={t("description")}>
      {"failed" in read ? (
        <ErrorState
          module="signals"
          code={read.failed}
          onRetry={() => setAttempt((count) => count + 1)}
        />
      ) : read.companies.length === 0 ? (
        <EmptyState message={t("empty")} />
      ) : (
        <ul className="grid gap-3">
          {read.companies.map((company) => (
            <li key={company.id} className="grid min-w-0 gap-0.5">
              <span className="font-medium wrap-anywhere">{company.name}</span>
              <span className="text-sm text-ink-muted wrap-anywhere">
                {[company.domain, company.town, company.country].filter(Boolean).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div>
        <ButtonLink href={foundScreen(workspace, { agent: playbookId })} variant="ghost">
          {t("view_all")}
          <ArrowRight aria-hidden="true" className="rtl:-scale-x-100" />
        </ButtonLink>
      </div>
    </Card>
  );
}
