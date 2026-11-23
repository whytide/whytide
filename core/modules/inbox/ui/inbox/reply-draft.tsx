// The AI's reply draft (README.md "The reply draft"; inbox-reply-draft), above the reply box
// (reply-box.tsx), on the caller's own thread whose channel sends now: the thread's draft read once
// (GET …/reply-draft), then the brief, optional, with the ui's counter of REPLY_BRIEF_MAX, and Draft
// reply, which sends POST …/reply-draft with the brief and an Idempotency-Key. While drafting, a
// status line, the draft read every DRAFT_POLL_MS for DRAFT_TIMEOUT_MS at most, then a hint with Try
// again, which reads on, as the ICP's draft card does. Ready: the text, read-only, with Use draft,
// which puts it in the reply box, replacing its text, and Draft again. Failed: its code in words,
// with Try again. Nothing here sends: Send in the reply box is the one press that does. A refusal
// shows in words (owner.ts), with Try again, which sends the failed press's key again.
"use client";

import { Button, ErrorState, TextArea } from "@whytide/ui";
import { CircleAlert, Sparkles, TriangleAlert } from "@whytide/ui/icons";
import { browserApi, data } from "@whytide/web/api/browser";
import { useMessages, useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { REPLY_BRIEF_MAX } from "../../domain/reply-draft/constants.ts";
import type { ReplyDraftResponse } from "../../schemas/reply-draft.ts";
import {
  BRIEF_ROWS,
  DRAFT_FAILURES,
  DRAFT_POLL_MS,
  DRAFT_TIMEOUT_MS,
  type DraftFailure,
  REPLY_DRAFT_PATH,
} from "./constants.ts";
import { ownerOf } from "./owner.tsx";

type Props = {
  workspace: string;
  threadId: string;
  /** The draft's text into the reply box, in place of what it holds. */
  onUse: (text: string) => void;
};
/** A failed call: its code, and the call again where one helps. */
type Problem = { readonly code: string; readonly retry?: () => void };

/** The code of a failed call, an ApiError's; else internal_error (no answer: the network). */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : "internal_error";
}

export function ReplyDraft({ workspace, threadId, onUse }: Props) {
  const t = useTranslations("inbox.draft");
  const whole = useTranslations();
  const messages = useMessages();
  const id = useId();
  const [draft, setDraft] = useState<ReplyDraftResponse>();
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>();
  /** When the part began to wait for the worker: past DRAFT_TIMEOUT_MS, it stops reading. */
  const [since, setSince] = useState(() => Date.now());
  const [stuck, setStuck] = useState(false);
  const running = useRef(false);
  /** The failed press's brief and key, until a press succeeds. */
  const last = useRef<{ readonly brief: string; readonly key: string }>(undefined);

  const read = useCallback(() => {
    const params = { path: { workspaceId: workspace, id: threadId } };
    return data(browserApi().GET(REPLY_DRAFT_PATH, { params }));
  }, [workspace, threadId]);
  /** A fresh wait for the worker: ten minutes more of reads. */
  const wait = useCallback(() => {
    setSince(Date.now());
    setStuck(false);
    setProblem(undefined);
  }, []);

  useEffect(() => {
    read().then(setDraft, (error) => setProblem({ code: codeOf(error) }));
  }, [read]);

  const polling = draft?.status === "drafting" && !stuck && problem === undefined;
  useEffect(() => {
    if (!polling) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = async () => {
      if (Date.now() - since >= DRAFT_TIMEOUT_MS) {
        setStuck(true);
        return;
      }
      try {
        const answer = await read();
        if (!live) return;
        setDraft(answer);
        timer = setTimeout(next, DRAFT_POLL_MS);
      } catch (error) {
        if (live) setProblem({ code: codeOf(error), retry: wait });
      }
    };
    timer = setTimeout(next, DRAFT_POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [polling, since, read, wait]);

  async function request(said: string) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setProblem(undefined);
    const key = last.current?.brief === said ? last.current.key : crypto.randomUUID();
    try {
      const params = {
        path: { workspaceId: workspace, id: threadId },
        header: { "Idempotency-Key": key },
      };
      const answer = await data(
        browserApi().POST(REPLY_DRAFT_PATH, { params, body: { brief: said } }),
      );
      last.current = undefined;
      wait();
      setDraft(answer);
    } catch (error) {
      last.current = { brief: said, key };
      setProblem({ code: codeOf(error), retry: () => void request(said) });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  const status = draft?.status ?? "none";
  const owner = problem && ownerOf(problem.code, messages);
  const failures: Record<DraftFailure, string> = {
    checks: t("failure.checks"),
    lead: t("failure.lead"),
    stuck: t("failure.stuck"),
    other: t("failure.other"),
  };
  const error = draft?.error ?? "";
  const kind = Object.hasOwn(DRAFT_FAILURES, error) ? DRAFT_FAILURES[error] : undefined;
  const failure = failures[kind ?? "other"];
  const press =
    status === "ready" ? t("again") : status === "failed" ? whole("ui.action.retry") : t("start");
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mt-6 grid max-w-3xl gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs"
    >
      <h2 id={`${id}-title`} className="flex items-center gap-2 font-semibold text-ink">
        <Sparkles aria-hidden="true" className="size-4 shrink-0 text-accent-ink" />
        {t("title")}
      </h2>
      {status === "drafting" ? (
        stuck ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-warm-soft px-3.5 py-3">
            <p role="status" className="flex min-w-0 flex-1 items-start gap-2.5 text-warm-ink">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {t("stuck")}
            </p>
            <Button size="sm" onClick={wait}>
              {whole("ui.action.retry")}
            </Button>
          </div>
        ) : (
          <p
            role="status"
            className="flex items-center gap-2.5 rounded-lg bg-accent-soft px-3.5 py-3 font-medium text-accent-ink"
          >
            <span className="wt-spinner" aria-hidden="true" />
            {t("drafting")}
          </p>
        )
      ) : (
        <>
          {status === "ready" && draft?.text ? (
            <figure className="grid gap-2">
              <figcaption className="text-xs text-ink-muted">{t("ready")}</figcaption>
              <p
                data-part="reply-draft-text"
                className="whitespace-pre-wrap text-pretty wrap-break-word rounded-lg bg-muted p-3 text-ink"
              >
                {draft.text}
              </p>
              <div>
                <Button variant="primary" size="sm" onClick={() => onUse(draft.text ?? "")}>
                  {t("use")}
                </Button>
              </div>
            </figure>
          ) : null}
          {status === "failed" ? (
            <div role="alert" className="wt-error-state">
              <p className="flex items-center gap-2 font-medium text-danger-ink">
                <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
                {t("failed")}
              </p>
              <p className="text-ink">{failure}</p>
            </div>
          ) : null}
          <TextArea
            label={t("brief")}
            hint={t("brief_hint")}
            rows={BRIEF_ROWS}
            maxLength={REPLY_BRIEF_MAX}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
          />
          <div>
            <Button loading={busy} onClick={() => void request(brief)}>
              <Sparkles aria-hidden="true" />
              {press}
            </Button>
          </div>
        </>
      )}
      {owner && problem ? (
        <ErrorState module={owner.module} code={owner.code} onRetry={problem.retry} />
      ) : null}
    </section>
  );
}
