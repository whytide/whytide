// The draft panel in the browser (panel.tsx), a card of the lead page: the sentence that nothing is
// sent from here; the channel, a segmented choice, and Draft, which asks the api for a draft (202,
// `drafting`), then reads it again until its writer ends: every two seconds at first, less often as
// the draft ages, and no more past twenty minutes, when a note says so with a button that reads it
// once more; the newest draft (draft.tsx) with Copy, Edit and Save, and Regenerate, which asks for a
// new draft and keeps this one; then every draft, newest first, on a timeline, or the empty state.
// Draft and Regenerate wait while a draft is being written. The facts the newest plan cites come
// from the page, else from one read of the dossier per dossier hash. A failure shows its code in
// words with a retry, which sends a press again with its key; a refused Save keeps the text and
// Save. DraftsFailed is the panel when the page's read failed.
"use client";

import { Button, EmptyState, ErrorState, Toast } from "@whytide/ui";
import { Hourglass, Info, RefreshCw, Sparkles } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useId, useState } from "react";
import { CHANNEL_ICON, CurrentDraft, type Facts, HistoryItem } from "./draft.tsx";
import type { Cited, Draft } from "./panel.tsx";
import { useDraftWords } from "./words.ts";

type Props = { workspace: string; personId: string; first: Draft[]; cited?: Cited };
type Failure = { readonly code: string; readonly retry?: () => void };

const POLL_MS = 2_000;
const POLL_MAX_MS = 30_000;
/** How long a draft may be written before the panel stops asking for it: longer than its writer's
 * three attempts of five minutes (README.md "The workflow"). */
const POLL_FOR_MS = 20 * 60_000;
const TOAST_MS = 2_000;
const CHANNELS = ["linkedin_note", "linkedin_message"] as const;
const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");

/**
 * The wait before a draft asked for at `createdAt` is read again: two seconds, then an eighth of its
 * age, thirty seconds at most; none past twenty minutes, when its writer may have stopped (a run
 * cancelled by hand, docs/runbook.md).
 */
function pollDelay(createdAt: string, now = Date.now()): number | undefined {
  const age = now - Date.parse(createdAt);
  if (age > POLL_FOR_MS) return undefined;
  return Math.min(POLL_MAX_MS, Math.max(POLL_MS, age / 8));
}

export function Drafts({ workspace, personId, first, cited: read }: Props) {
  const t = useTranslations("messaging.draft");
  const { channel: channelText } = useDraftWords();
  const ids = { title: useId(), history: useId() };
  const [drafts, setDrafts] = useState(first);
  const [channel, setChannel] = useState(first[0]?.channel ?? "linkedin_note");
  const [asking, setAsking] = useState<"draft" | "regenerate">();
  const [failure, setFailure] = useState<Failure>();
  const [toast, setToast] = useState<string>();
  const [cited, setCited] = useState(read);
  /** The draft being written that the panel no longer asks for, set in the browser alone. */
  const [stopped, setStopped] = useState<string>();
  const [current] = drafts;
  const writing = drafts.find((draft) => draft.status === "drafting");
  const lead = { workspaceId: workspace, personId };
  const replace = (draft: Draft) =>
    setDrafts((all) => all.map((one) => (one.id === draft.id ? draft : one)));

  /** The draft read again, in place of the one shown; a failure's retry reads it again. */
  async function check(id: string) {
    try {
      const params = { path: { workspaceId: workspace, id } };
      const path = "/v1/workspaces/{workspaceId}/messaging/drafts/{id}";
      replace(await data(browserApi().GET(path, { params })));
    } catch (error) {
      const retry = () => {
        setFailure(undefined);
        void check(id);
      };
      setFailure({ code: codeOf(error), retry });
    }
  }

  // The draft being written, asked for again until its writer ends; too old, no more. The browser's
  // clock decides, after the page's render, which the server's and the browser's then match.
  useEffect(() => {
    if (writing === undefined || stopped === writing.id || failure) return;
    const delay = pollDelay(writing.createdAt);
    if (delay === undefined) {
      setStopped(writing.id);
      return;
    }
    const timer = setTimeout(() => void check(writing.id), delay);
    return () => clearTimeout(timer);
  }, [writing, stopped, failure]);

  // The dossier's facts, once per hash of the newest written plan that the page did not read.
  const wanted = current?.plan && current.status !== "drafting" ? current.dossierHash : null;
  useEffect(() => {
    if (wanted === null || cited?.asked === wanted || failure) return;
    let live = true;
    const params = { path: { workspaceId: workspace, personId } };
    data(
      browserApi().GET("/v1/workspaces/{workspaceId}/messaging/leads/{personId}/dossier", {
        params,
      }),
    )
      .then(
        ({ dossierHash, facts }) => live && setCited({ asked: wanted, hash: dossierHash, facts }),
      )
      .catch(
        (error: unknown) =>
          live && setFailure({ code: codeOf(error), retry: () => setFailure(undefined) }),
      );
    return () => {
      live = false;
    };
  }, [wanted, cited, failure, workspace, personId]);

  useEffect(() => {
    if (toast === undefined) return;
    const timer = setTimeout(() => setToast(undefined), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  /**
   * A new draft on top, `drafting`: Draft's of the channel, or Regenerate's of the newest. One key
   * per press, which its retry sends again: the api answers a request once (core/apps/api
   * "Request protection").
   */
  async function ask(kind: "draft" | "regenerate", key = crypto.randomUUID()) {
    setAsking(kind);
    setFailure(undefined);
    try {
      const api = browserApi();
      const header = { "Idempotency-Key": key };
      const draft =
        kind === "draft" || current === undefined
          ? await data(
              api.POST("/v1/workspaces/{workspaceId}/messaging/leads/{personId}/drafts", {
                params: { path: lead, header },
                body: { channel },
              }),
            )
          : await data(
              api.POST("/v1/workspaces/{workspaceId}/messaging/drafts/{id}/regenerate", {
                params: { path: { workspaceId: workspace, id: current.id }, header },
              }),
            );
      setDrafts((all) => [draft, ...all]);
    } catch (error) {
      setFailure({ code: codeOf(error), retry: () => void ask(kind, key) });
    } finally {
      setAsking(undefined);
    }
  }

  /** The member's own text saved; false when the api refused it. */
  async function save(id: string, editedText: string): Promise<boolean> {
    setFailure(undefined);
    try {
      const params = { path: { workspaceId: workspace, id } };
      const path = "/v1/workspaces/{workspaceId}/messaging/drafts/{id}";
      replace(await data(browserApi().PATCH(path, { params, body: { editedText } })));
      return true;
    } catch (error) {
      setFailure({ code: codeOf(error) });
      return false;
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setToast(t("copied"));
    } catch {
      setToast(t("copy_failed"));
    }
  }

  /** What the newest plan's facts are: read, being read, or of another dossier than today's. */
  let facts: Facts | undefined;
  if (current?.plan) {
    if (wanted === null) facts = "stale";
    else if (cited?.asked !== wanted) facts = "reading";
    else if (cited.hash !== wanted) facts = "stale";
    else facts = current.plan.factIds.flatMap((id) => cited.facts.filter((fact) => fact.id === id));
  }

  return (
    <PanelCard titleId={ids.title}>
      <p className="flex items-start gap-2 text-ink-muted">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {t("nothing_sent")}
      </p>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <fieldset className="min-w-0">
          <legend className="mb-1.5 text-xs font-medium text-ink-muted">
            {t("channel.label")}
          </legend>
          <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 ring-1 ring-line ring-inset">
            {CHANNELS.map((value) => {
              const Icon = CHANNEL_ICON[value];
              return (
                <label
                  key={value}
                  className="relative flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-ink-muted transition-colors hover:text-ink has-checked:bg-surface has-checked:text-ink has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus forced-colors:has-checked:outline-2 forced-colors:has-checked:outline-[Highlight]"
                >
                  {/* The native radio over its whole label: the arrows and a click choose, and its
                      label's ring shows the keyboard's focus; in forced colours, where the
                      background and the shadow are gone, an outline shows the chosen one. */}
                  <input
                    type="radio"
                    name={`${ids.title}-channel`}
                    value={value}
                    checked={channel === value}
                    onChange={() => setChannel(value)}
                    className="absolute inset-0 size-full cursor-pointer appearance-none rounded-md opacity-0"
                  />
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  {channelText[value]}
                </label>
              );
            })}
          </div>
        </fieldset>
        <Button
          variant="primary"
          loading={asking === "draft"}
          disabled={writing !== undefined}
          onClick={() => ask("draft")}
        >
          {asking !== "draft" && <Sparkles aria-hidden="true" />}
          {t("create")}
        </Button>
      </div>
      {failure && <ErrorState module="messaging" code={failure.code} onRetry={failure.retry} />}
      {writing && stopped === writing.id && (
        <div
          role="status"
          className="grid justify-items-start gap-2.5 rounded-lg border border-warm-dot/30 bg-warm-soft px-4 py-3 text-warm-ink"
        >
          <p className="flex items-start gap-2">
            <Hourglass aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t("stuck", { minutes: POLL_FOR_MS / 60_000 })}
          </p>
          <Button size="sm" onClick={() => check(writing.id)}>
            <RefreshCw aria-hidden="true" />
            {t("check")}
          </Button>
        </div>
      )}
      {current ? (
        <CurrentDraft
          key={current.id}
          draft={current}
          facts={facts}
          writing={writing !== undefined}
          regenerating={asking === "regenerate"}
          onCopy={copy}
          onSave={(editedText) => save(current.id, editedText)}
          onRegenerate={() => ask("regenerate")}
        />
      ) : (
        <EmptyState message={t("empty")} />
      )}
      {drafts.length > 0 && (
        <div className="grid gap-3 border-t border-line pt-4">
          <h3 id={ids.history} className="text-sm font-semibold text-ink">
            {t("history")}
          </h3>
          <ol aria-labelledby={ids.history} className="grid gap-4">
            {drafts.map((draft) => (
              <HistoryItem key={draft.id} draft={draft} />
            ))}
          </ol>
        </div>
      )}
      <Toast message={toast} />
    </PanelCard>
  );
}

/** The panel's card, as the lead page's others: a region named by its heading, then `children`. */
function PanelCard({ titleId, children }: { titleId: string; children: ReactNode }) {
  const t = useTranslations("messaging.draft");
  return (
    <section
      aria-labelledby={titleId}
      className="@container grid content-start gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs"
    >
      <h2 id={titleId} className="font-semibold text-ink">
        {t("title")}
      </h2>
      {children}
    </section>
  );
}

/** The panel when the page could not read its drafts: the code in words, and a retry that reads the page again. */
export function DraftsFailed({ code }: { code: string }) {
  const t = useTranslations("messaging.draft");
  const router = useRouter();
  const title = useId();
  return (
    <PanelCard titleId={title}>
      <p className="text-ink-muted">{t("error")}</p>
      <ErrorState module="messaging" code={code} onRetry={() => router.refresh()} />
    </PanelCard>
  );
}
