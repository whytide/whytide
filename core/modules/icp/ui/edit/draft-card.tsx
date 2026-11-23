// The draft card (README "The screen"), a client component at the top of the ICP screen: the worker
// drafts the ICP from Company Knowledge and an optional brief, as for `pnpm icp:draft`. No draft, or
// a failed one: a line on what it does, the brief and Draft, which needs a brief while Company
// Knowledge is empty, the card then linking to the Company screen; drafting: a status line while the
// card reads the draft every two seconds, for ten minutes at most, then whether the worker runs, with
// a retry; drafted: the proposal, read-only, with Use this draft, which asks first over targeting or
// the form's unsaved changes, and Discard. A route's code shows in words in the card, any other code
// in an ErrorState. The card drafts the audience the screen shows: the default's routes without an
// id, as before audiences, another audience's with its id (`?icpId=`).
"use client";

import { Button, Card, Dialog, ErrorState, Link, TextArea } from "@whytide/ui";
import { CircleAlert, Sparkles, TriangleAlert } from "@whytide/ui/icons";
import { browserApi, data } from "@whytide/web/api/browser";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { DRAFT_POLL_MS, DRAFT_TIMEOUT_MS } from "../../domain/constants.ts";
import { LIMITS } from "../../domain/lists.ts";
import type { DraftResponse, IcpResponse } from "../../schemas/icp.ts";
import { type DraftCode, draftErrorLabels, seniorityLabels, sizeRangeLabels } from "../labels.ts";
import { CARD_CODES, companyScreen, DRAFT_PATH } from "./constants.ts";

type Proposal = NonNullable<DraftResponse["pending"]>["fields"];
type Busy = "draft" | "accept" | "discard";
/** A failed press: its code, and the retry that sends the same request again where one helps. */
type Problem = { readonly code: string; readonly retry?: () => void };
type Props = {
  workspace: string;
  /** The audience the screen shows when it is not the default; the default's draft needs none. */
  icpId?: string;
  draft: DraftResponse;
  /** The ICP has targeting, or the form has changes it has not saved: Use asks first. */
  replaces: boolean;
  /** The ICP as Use this draft saved it, which the form then shows. */
  onAccepted: (icp: IcpResponse) => void;
};

/** The code of a failed call, an ApiError's; else internal_error (no answer: the network). */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : "internal_error";
}

export function DraftCard({ workspace, icpId, draft: first, replaces, onAccepted }: Props) {
  const t = useTranslations("icp.draft");
  const whole = useTranslations();
  const hint = useId();
  const [draft, setDraft] = useState(first);
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState<Busy>();
  const [problem, setProblem] = useState<Problem>();
  const [asking, setAsking] = useState(false);
  /** The api refused Use over targeting the form did not know of: the next Use asks first. */
  const [overTargeting, setOverTargeting] = useState(false);
  /** When the card began to wait for the worker: past DRAFT_TIMEOUT_MS, it stops reading. */
  const [since, setSince] = useState(() => Date.now());
  const [stuck, setStuck] = useState(false);
  const [readFailure, setReadFailure] = useState<string>();
  const words = draftErrorLabels(whole);
  const inWords = (code: string) =>
    Object.hasOwn(words, code) ? words[code as DraftCode] : undefined;
  const params = { path: { workspaceId: workspace }, ...(icpId ? { query: { icpId } } : {}) };
  const polling = draft.status === "drafting" && !stuck && readFailure === undefined;

  useEffect(() => {
    if (!polling) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (Date.now() - since >= DRAFT_TIMEOUT_MS) {
        setStuck(true);
        return;
      }
      try {
        const query = icpId ? { query: { icpId } } : {};
        const next = await data(
          browserApi().GET(DRAFT_PATH, { params: { path: { workspaceId: workspace }, ...query } }),
        );
        if (!live) return;
        setDraft(next);
        timer = setTimeout(read, DRAFT_POLL_MS);
      } catch (error) {
        if (live) setReadFailure(codeOf(error));
      }
    };
    timer = setTimeout(read, DRAFT_POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [polling, since, workspace, icpId]);

  /** A fresh wait for the worker: ten minutes more of reads. */
  const wait = () => {
    setSince(Date.now());
    setStuck(false);
    setReadFailure(undefined);
  };
  /** The draft as the api holds it, after a press found none: used or discarded meanwhile. */
  const reload = async () => {
    wait();
    try {
      setDraft(await data(browserApi().GET(DRAFT_PATH, { params })));
    } catch (error) {
      setReadFailure(codeOf(error));
    }
  };

  /**
   * Runs a press's call with an Idempotency-Key of its own; its retry sends the same key and body,
   * so that the api runs a repeat once (core/apps/api "Request protection"). A route's code shows in
   * words, without a retry; any other code in an ErrorState, with it.
   */
  async function press(action: Busy, call: (key: string) => Promise<void>, key?: string) {
    const sent = key ?? crypto.randomUUID();
    setBusy(action);
    setProblem(undefined);
    try {
      await call(sent);
    } catch (error) {
      const code = codeOf(error);
      if (code === CARD_CODES.notEmpty) setOverTargeting(true);
      if (code === CARD_CODES.none) void reload();
      const retry = inWords(code) === undefined ? () => void press(action, call, sent) : undefined;
      setProblem({ code, retry });
    } finally {
      setBusy(undefined);
    }
  }
  const header = (key: string) => ({ ...params, header: { "Idempotency-Key": key } });
  const request = () => {
    const body = { brief };
    return press("draft", async (key) => {
      const next = await data(browserApi().POST(DRAFT_PATH, { params: header(key), body }));
      wait();
      setDraft(next);
    });
  };
  /** Saves the proposal of the run the card shows: a later request's since is icp_draft_none. */
  const accept = (replace: boolean, runId: string) =>
    press("accept", async (key) => {
      const body = { replace, runId };
      const api = browserApi();
      const icp = await data(api.POST(`${DRAFT_PATH}/accept`, { params: header(key), body }));
      setOverTargeting(false);
      setDraft((current) => ({ ...current, status: "none", error: null, pending: null }));
      onAccepted(icp);
    });
  const discard = () =>
    press("discard", async (key) => {
      const api = browserApi();
      setDraft(await data(api.POST(`${DRAFT_PATH}/discard`, { params: header(key) })));
    });
  /** Use: at once over an empty ICP and a saved form; else once the member confirmed. */
  const use = (runId: string) => {
    if (replaces || overTargeting) setAsking(true);
    else void accept(false, runId);
  };

  const proposal = draft.status === "drafted" ? draft.pending : null;
  const failed = draft.status === "failed";
  const refusal = problem === undefined ? undefined : inWords(problem.code);
  return (
    // Its own space before the form, as the page header keeps its own.
    <div data-part="icp-draft" className="pb-6">
      <Card
        title={proposal ? t("ready") : t("title")}
        description={proposal ? undefined : t("description")}
      >
        {proposal ? (
          <>
            <ProposalView fields={proposal.fields} />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line pt-4">
              <p className="min-w-0 flex-1 basis-64 text-pretty text-xs text-ink-muted">
                {whole("icp.screen.rescore_note")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button loading={busy === "discard"} onClick={() => void discard()}>
                  {t("discard")}
                </Button>
                <Button
                  variant="primary"
                  loading={busy === "accept"}
                  onClick={() => use(proposal.runId)}
                >
                  {t("use")}
                </Button>
              </div>
            </div>
          </>
        ) : draft.status === "drafting" ? (
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
            {failed ? (
              <div role="alert" className="wt-error-state">
                <p className="flex items-center gap-2 font-medium text-danger-ink">
                  <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
                  {t("failed")}
                </p>
                <p className="text-ink">{inWords(draft.error ?? "") ?? words.draft_failed}</p>
              </div>
            ) : null}
            {draft.hasKnowledge ? null : (
              <p id={hint} className="text-pretty text-ink-muted">
                {t.rich("no_knowledge", {
                  link: (chunks) => <Link href={companyScreen(workspace)}>{chunks}</Link>,
                })}
              </p>
            )}
            <TextArea
              label={t("brief")}
              hint={t("brief_hint")}
              maxLength={LIMITS.brief}
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
            />
            <div>
              <Button
                variant="primary"
                loading={busy === "draft"}
                disabled={!draft.hasKnowledge && brief.trim() === ""}
                aria-describedby={draft.hasKnowledge ? undefined : hint}
                onClick={() => void request()}
              >
                <Sparkles aria-hidden="true" />
                {failed ? t("again") : t("start")}
              </Button>
            </div>
          </>
        )}
        {problem === undefined ? null : refusal !== undefined ? (
          <p role="alert" className="flex items-start gap-2 text-danger-ink">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {refusal}
          </p>
        ) : (
          <ErrorState module="icp" code={problem.code} onRetry={problem.retry} />
        )}
        {readFailure === undefined ? null : (
          <ErrorState module="icp" code={readFailure} onRetry={() => void reload()} />
        )}
      </Card>
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title={t("confirm_title")}
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setAsking(false);
              if (proposal) void accept(true, proposal.runId);
            }}
          >
            {t("use")}
          </Button>
        }
      >
        <p className="text-pretty">{t("confirm")}</p>
      </Dialog>
    </div>
  );
}

/**
 * The drafted fields, read-only, in the form's order: the closed lists by their labels, the countries
 * by their names in the user's locale, each list's values as chips that wrap rather than widen the
 * page on a phone.
 */
function ProposalView({ fields }: { fields: Proposal }) {
  const t = useTranslations("icp.screen");
  const draft = useTranslations("icp.draft");
  const whole = useTranslations();
  const locale = useLocale();
  const seniorities = seniorityLabels(whole);
  const sizes = sizeRangeLabels(whole);
  const regions = new Intl.DisplayNames([locale], { type: "region" });
  const rows: [field: string, label: string, value: string | readonly string[]][] = [
    ["name", t("name"), fields.name],
    ["titles", t("titles"), fields.titles],
    ["seniorities", t("seniorities"), fields.seniorities.map((value) => seniorities[value])],
    ["industries", t("industries"), fields.industries],
    ["sizeRanges", t("size_ranges"), fields.sizeRanges.map((value) => sizes[value])],
    ["countries", t("countries"), fields.countries.map((code) => regions.of(code) ?? code)],
    ["mustHaves", t("must_haves"), fields.mustHaves],
    ["disqualifiers", t("disqualifiers"), fields.disqualifiers],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
      {rows.map(([field, label, value]) => (
        <div key={field} data-proposal={field} className="grid min-w-0 content-start gap-1.5">
          <dt className="text-xs font-medium text-ink-muted">{label}</dt>
          <dd className="min-w-0">
            {value.length === 0 ? (
              <span className="text-ink-subtle">{draft("empty")}</span>
            ) : typeof value === "string" ? (
              <p className="text-pretty wrap-anywhere text-ink">{value}</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {/* Keyed by place and text, so two equal values keep apart: the lists never reorder. */}
                {value.map((item, at) => (
                  <li
                    key={`${at}:${item}`}
                    className="min-w-0 max-w-full rounded-md border border-line bg-muted px-2 py-0.5 wrap-anywhere text-ink"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
