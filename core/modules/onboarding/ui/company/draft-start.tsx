// The start of a Draft on the Company screen (README "The screen"), shared by the website's Draft and
// the documents' card: the confirm when a draft waits for review, which a Draft drops; the form saved
// first when its website changed, so that the fetch reads what is typed; then the POST, its body the
// documents read, under an Idempotency-Key its retry sends again, so that the api runs a repeat once;
// a refusal in words with that retry, but for no website and no document, which only a change helps.
"use client";

import { Button, Dialog, ErrorState } from "@whytide/ui";
import { browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import type { CompanyKnowledgeResponse, DraftBody } from "../../schemas/company-knowledge.ts";
import { codeOf, type Problem } from "./problem.ts";

type Knowledge = CompanyKnowledgeResponse;
type Body = NonNullable<DraftBody>;
export type DraftStartProps = {
  workspace: string;
  record: Knowledge;
  /** The record to draft from, the form saved first when its website changed; none when refused. */
  prepare: () => Promise<Knowledge | undefined>;
  onRecord: (record: Knowledge) => void;
};

const PATH = "/v1/workspaces/{workspaceId}/onboarding/company-knowledge/draft";

/**
 * A Draft's button's press, with `body`, and while it starts; the confirm, its button named `label`,
 * and the refusal, both to render beside the button. `onStart` runs before each start.
 */
export function useDraftStart(
  { workspace, record, prepare, onRecord }: DraftStartProps,
  label: string,
  onStart?: () => void,
): { press: (body?: Body) => void; starting: boolean; confirm: ReactNode; problem: ReactNode } {
  const t = useTranslations("onboarding");
  const [starting, setStarting] = useState(false);
  const [asking, setAsking] = useState<Body>();
  const [problem, setProblem] = useState<Problem>();

  async function start(body: Body, key: string = crypto.randomUUID()) {
    setStarting(true);
    setProblem(undefined);
    onStart?.();
    let code = "internal_error";
    try {
      if ((await prepare()) === undefined) return;
      const params = { path: { workspaceId: workspace }, header: { "Idempotency-Key": key } };
      return onRecord(await data(browserApi().POST(PATH, { params, body })));
    } catch (error) {
      code = codeOf(error);
    } finally {
      setStarting(false);
    }
    // Without a website or a document, only adding one helps: no retry.
    const retry = code === "company_knowledge_no_website" ? undefined : () => start(body, key);
    setProblem({ code, retry });
  }

  /** A Draft drops the draft waiting for review (README "The drafter"): the person confirms first. */
  function press(body: Body = {}) {
    if (record.pendingDraft) setAsking(body);
    else void start(body);
  }

  const confirm = (
    <Dialog
      open={asking !== undefined}
      onClose={() => setAsking(undefined)}
      title={t("company.draft_pending_confirm")}
      actions={
        <Button
          variant="primary"
          onClick={() => {
            setAsking(undefined);
            if (asking !== undefined) void start(asking);
          }}
        >
          {label}
        </Button>
      }
    />
  );
  const refusal = problem ? (
    <ErrorState module="onboarding" code={problem.code} onRetry={problem.retry} />
  ) : null;
  return { press, starting, confirm, problem: refusal };
}
