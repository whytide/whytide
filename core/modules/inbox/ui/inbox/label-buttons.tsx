// A reply's label (thread.tsx): two buttons, Positive and Not positive, the chosen one pressed. A
// press sends PUT …/inbox/messages/{id}/label with its label and shows the answer's; a press on the
// other one changes it, and one on the pressed one sends nothing. The label is never removed, only
// changed. A refusal shows its code in words, its module's (src/api/errors.ts errorOwner), with Try
// again, which sends the press again.
"use client";

import { Button, ErrorState } from "@whytide/ui";
import { ThumbsDown, ThumbsUp } from "@whytide/ui/icons";
import { ApiError, browserApi, data, errorOwner } from "@whytide/web/api/browser";
import { useMessages, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import type { LabelResponse } from "../../schemas/threads.ts";

type Value = LabelResponse["label"];
type Props = { workspace: string; messageId: string; label: LabelResponse | null };
/** A press that failed: its digest, and the label it asked for. */
type Failure = { readonly digest: string; readonly value: Value };

const digestOf = (error: unknown) =>
  error instanceof ApiError ? error.digest : new ApiError(500, undefined).digest;

export function LabelButtons({ workspace, messageId, label: first }: Props) {
  const t = useTranslations("inbox.label");
  const messages = useMessages();
  const [label, setLabel] = useState(first?.label);
  const [pending, setPending] = useState<Value>();
  const [failure, setFailure] = useState<Failure>();
  const running = useRef(false);

  async function choose(value: Value) {
    if (running.current || value === label) return;
    running.current = true;
    setPending(value);
    setFailure(undefined);
    try {
      const answer = await data(
        browserApi().PUT("/v1/workspaces/{workspaceId}/inbox/messages/{id}/label", {
          params: { path: { workspaceId: workspace, id: messageId } },
          body: { label: value },
        }),
      );
      setLabel(answer.label);
    } catch (error) {
      setFailure({ digest: digestOf(error), value });
    } finally {
      running.current = false;
      setPending(undefined);
    }
  }

  const owner = failure && errorOwner({ digest: failure.digest }, messages);
  return (
    <div className="grid justify-items-start gap-2">
      <div role="group" aria-label={t("group")} className="flex flex-wrap gap-2">
        <Button
          size="sm"
          aria-pressed={label === "positive"}
          loading={pending === "positive"}
          onClick={() => void choose("positive")}
        >
          <ThumbsUp aria-hidden="true" />
          {t("positive")}
        </Button>
        <Button
          size="sm"
          aria-pressed={label === "not_positive"}
          loading={pending === "not_positive"}
          onClick={() => void choose("not_positive")}
        >
          <ThumbsDown aria-hidden="true" />
          {t("not_positive")}
        </Button>
      </div>
      {owner && failure && (
        <ErrorState
          module={owner.module}
          code={owner.code}
          onRetry={() => void choose(failure.value)}
        />
      )}
    </div>
  );
}
