// The prompt at sign-in (README "The prompt at sign-in"), a client component in the workspace home's
// `home` slot (slot.tsx): the website's field, Build and Skip. Build saves the website, then asks for
// a Draft that accepts itself, then shows the steps, the record and then the ICP asked for again
// every two seconds (progress.ts) until the end: what was saved, the links to review it, and Done. A
// failed run in words, with Try again and Skip. Skip and Done hide the card in this tab until the
// next sign-in (sessionStorage, a key per workspace). The server renders the card, so that the home
// does not move once it loads; a tab that hid it hides it once it runs.
"use client";

import { Button, ButtonLink, Card, ErrorState, TextField } from "@whytide/ui";
import { Circle, CircleCheck, RotateCw, Sparkles, TriangleAlert } from "@whytide/ui/icons";
import { browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { type FormEvent, useEffect, useState, useSyncExternalStore } from "react";
import { LIMITS } from "../../domain/fields.ts";
import type {
  CompanyKnowledgeBody,
  CompanyKnowledgeResponse,
} from "../../schemas/company-knowledge.ts";
import { DRAFTER_CODES, POLL_MS } from "../company/constants.ts";
import { codeOf, type Problem } from "../company/problem.ts";
import { RunFailure } from "../company/website-fetch.tsx";
import { HIDDEN_KEY } from "./constants.ts";
import {
  hasTargeting,
  type Icp,
  type IcpDraft,
  type IcpStart,
  outcomeOf,
  type Step,
  type StepState,
  stageOf,
  stepsOf,
} from "./progress.ts";

type Knowledge = CompanyKnowledgeResponse;
type Props = { workspace: string; initial: Knowledge };

const KNOWLEDGE = "/v1/workspaces/{workspaceId}/onboarding/company-knowledge";
const DRAFT = "/v1/workspaces/{workspaceId}/onboarding/company-knowledge/draft";
const ICP = "/v1/workspaces/{workspaceId}/icp";
const ICP_DRAFT = "/v1/workspaces/{workspaceId}/icp/draft";

/** A line of the run's state, as the Company screen's. */
const NOTE = "flex items-start gap-2.5 rounded-lg px-3.5 py-3";

/** sessionStorage tells a tab nothing of its own writes: Skip and Done render the card away. */
const subscribe = () => () => undefined;

function isHidden(workspace: string): boolean {
  try {
    return sessionStorage.getItem(`${HIDDEN_KEY}:${workspace}`) !== null;
  } catch {
    return false;
  }
}

function hide(workspace: string): void {
  try {
    sessionStorage.setItem(`${HIDDEN_KEY}:${workspace}`, "1");
  } catch {
    // Refused, in a private window say: the card hides on this page only.
  }
}

/** What the PUT sends: the website typed, and every content field as the record holds it. */
function bodyOf(record: Knowledge, sourceUrl: string): CompanyKnowledgeBody {
  const { oneLiner, longDescription, products, painPoints, featuresBenefits } = record;
  const { proofPoints, competitors, tone } = record;
  const lists = { products, painPoints, featuresBenefits, proofPoints, competitors };
  return { sourceUrl, oneLiner, longDescription, ...lists, tone };
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "active") return <span className="wt-spinner text-accent-ink" aria-hidden="true" />;
  const icon = "size-4 shrink-0";
  if (state === "done")
    return <CircleCheck aria-hidden="true" className={`${icon} text-success-ink`} />;
  if (state === "stopped")
    return <TriangleAlert aria-hidden="true" className={`${icon} text-warm-ink`} />;
  return <Circle aria-hidden="true" className={`${icon} text-ink-subtle`} />;
}

export function GetStarted({ workspace, initial }: Props) {
  const t = useTranslations("onboarding");
  const shared = useTranslations("ui");
  const format = useFormatter();
  const locale = useLocale();
  const hidden = useSyncExternalStore(
    subscribe,
    () => isHidden(workspace),
    () => false,
  );
  const [dismissed, setDismissed] = useState(false);
  const [record, setRecord] = useState(initial);
  const [started, setStarted] = useState(initial.fetchStatus === "failed");
  const [website, setWebsite] = useState(initial.sourceUrl ?? "");
  const [fieldError, setFieldError] = useState<string>();
  const [pressing, setPressing] = useState(false);
  const [problem, setProblem] = useState<Problem>();
  const [readFailure, setReadFailure] = useState<string>();
  const [start, setStart] = useState<IcpStart>();
  const [icp, setIcp] = useState<Icp>();
  const [draft, setDraft] = useState<IcpDraft>();
  const stage = stageOf(record, started);
  const outcome = outcomeOf(start, icp, draft, record.updatedAt);
  const path = { workspaceId: workspace };

  // A run already going when the page loaded: the ICP as it stands, before the run can change it.
  useEffect(() => {
    if (initial.fetchStatus !== "fetching" && initial.fetchStatus !== "fetched") return;
    const params = { path: { workspaceId: workspace } };
    browserApi()
      .GET(ICP, { params })
      .then(
        ({ data: read }) => {
          if (read === undefined) return;
          setIcp((current) => current ?? read);
          setStart((current) => current ?? { set: hasTargeting(read), updatedAt: read.updatedAt });
        },
        () => undefined,
      );
  }, [initial, workspace]);

  // The record while its run goes, then the ICP until it ends, every two seconds.
  const polling =
    readFailure === undefined &&
    (stage === "running" || (stage === "saved" && outcome === "waiting"));
  const icpPhase = stage === "saved";
  useEffect(() => {
    if (!polling) return;
    const params = { path: { workspaceId: workspace } };
    const timer = setInterval(async () => {
      try {
        const api = browserApi();
        if (icpPhase) {
          const [read, latest] = await Promise.all([
            data(api.GET(ICP, { params })),
            data(api.GET(ICP_DRAFT, { params })),
          ]);
          setIcp(read);
          setDraft(latest);
        } else {
          setRecord(await data(api.GET(KNOWLEDGE, { params })));
        }
      } catch (error) {
        setReadFailure(codeOf(error));
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, icpPhase, workspace]);

  /** A refused save: the website's field in the form's words, or the failure with its retry. */
  function refuse(error: unknown, retry: () => void) {
    const { code, details } = (error ?? {}) as { code?: unknown; details?: { fields?: string[] } };
    if (!details?.fields?.includes("sourceUrl")) {
      return setProblem({ code: typeof code === "string" ? code : "internal_error", retry });
    }
    const url = code === "company_knowledge_invalid_url";
    setFieldError(url ? t("errors.company_knowledge_invalid_url") : t("company.invalid"));
  }

  /**
   * Build, and its retry under the same `key`: the ICP read before anything changes it, the website
   * saved with the record's fields as they are now, then the Draft that accepts itself.
   */
  async function build(key: string) {
    setPressing(true);
    setProblem(undefined);
    setFieldError(undefined);
    setReadFailure(undefined);
    const retry = () => void build(key);
    try {
      const api = browserApi();
      const before = await data(api.GET(ICP, { params: { path } }));
      const current = await data(api.GET(KNOWLEDGE, { params: { path } }));
      const body = bodyOf(current, website.trim());
      const { data: saved, error } = await api.PUT(KNOWLEDGE, { params: { path }, body });
      if (saved === undefined) return refuse(error, retry);
      setRecord(saved);
      const params = { path, header: { "Idempotency-Key": key } };
      const run = await data(api.POST(DRAFT, { params, body: { autoAccept: true } }));
      setStart({ set: hasTargeting(before), updatedAt: before.updatedAt });
      setIcp(before);
      setDraft(undefined);
      setRecord(run);
      setStarted(true);
    } catch (error) {
      setProblem({ code: codeOf(error), retry });
    } finally {
      setPressing(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void build(crypto.randomUUID());
  }

  function finish() {
    hide(workspace);
    setDismissed(true);
  }

  if (hidden || dismissed) return null;

  const company = `/w/${workspace}/company`;
  const labels: Record<Step, string> = {
    reading: t("get_started.step.reading"),
    drafting: t("get_started.step.drafting"),
    saved: t("get_started.step.saved"),
    icp_building: t("get_started.step.icp_building"),
    icp_saved: t("get_started.step.icp_saved"),
  };
  const states: Record<StepState, string> = {
    done: t("get_started.state.done"),
    active: t("get_started.state.active"),
    next: t("get_started.state.next"),
    stopped: t("get_started.state.stopped"),
  };
  const ended = stage === "saved" && outcome !== "waiting";
  const drafterFailed = DRAFTER_CODES.some((code) => code === record.fetchError);
  const skip = (
    <ButtonLink href={company} variant="ghost" onClick={() => hide(workspace)}>
      {t("get_started.skip")}
    </ButtonLink>
  );
  const regions = new Intl.DisplayNames([locale], { type: "region" });
  const facts: [label: string, value: string][] = [
    [t("company.one_liner"), record.oneLiner],
    [t("company.products"), format.number(record.products.length)],
    [t("company.competitors"), format.number(record.competitors.length)],
    ...(icp && (outcome === "saved" || outcome === "set")
      ? ([
          [t("get_started.summary.titles"), format.list(icp.titles)],
          [t("get_started.summary.industries"), format.list(icp.industries)],
          [
            t("get_started.summary.countries"),
            format.list(icp.countries.map((code) => regions.of(code) ?? code)),
          ],
        ] as [string, string][])
      : []),
  ];
  const icpLine =
    outcome === "set"
      ? t("get_started.icp.set")
      : outcome === "review"
        ? t("get_started.icp.review")
        : outcome === "failed"
          ? t("get_started.icp.failed")
          : outcome === "stuck"
            ? t("get_started.icp.stuck")
            : undefined;

  return (
    <div data-part="get-started" data-stage={stage} className="mb-6">
      <Card title={t("get_started.title")} description={t("get_started.body")}>
        {stage === "form" || stage === "failed" ? (
          <form onSubmit={submit} noValidate className="grid gap-4">
            {stage === "failed" ? (
              <div role="alert" className="wt-error-state">
                <p className="font-medium text-danger-ink">
                  {drafterFailed ? t("company.draft_failed") : t("company.fetch_failed")}
                </p>
                <p className="text-ink">
                  <RunFailure code={record.fetchError} />
                </p>
              </div>
            ) : null}
            <TextField
              type="url"
              label={t("company.source_url")}
              value={website}
              maxLength={LIMITS.url}
              error={fieldError}
              onChange={(event) => setWebsite(event.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                variant="primary"
                loading={pressing}
                disabled={website.trim() === ""}
              >
                {stage === "failed" ? (
                  <RotateCw aria-hidden="true" />
                ) : (
                  <Sparkles aria-hidden="true" />
                )}
                {stage === "failed" ? shared("action.retry") : t("get_started.build")}
              </Button>
              {skip}
            </div>
            {problem ? (
              <ErrorState module="onboarding" code={problem.code} onRetry={problem.retry} />
            ) : null}
          </form>
        ) : null}
        {stage === "running" || stage === "saved" ? (
          <ol aria-label={t("get_started.steps")} aria-live="polite" className="grid gap-2">
            {stepsOf(record, stage, outcome).map(([step, state]) => (
              <li
                key={step}
                data-step={step}
                data-state={state}
                aria-current={state === "active" ? "step" : undefined}
                className="flex items-center gap-2.5"
              >
                <StepIcon state={state} />
                <span className={state === "next" ? "text-ink-muted" : "text-ink"}>
                  {labels[step]}
                </span>
                <span className="sr-only">{states[state]}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {stage === "stuck" || stage === "review" ? (
          <div className="grid gap-3">
            {stage === "stuck" ? (
              <p role="status" className={`${NOTE} bg-warm-soft text-warm-ink`}>
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                {t("get_started.stuck")}
              </p>
            ) : (
              <p role="status" className={`${NOTE} bg-accent-soft text-accent-ink`}>
                <Sparkles aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                {t("get_started.review")}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {stage === "stuck" ? (
                <Button
                  variant="primary"
                  loading={pressing}
                  onClick={() => void build(crypto.randomUUID())}
                >
                  <RotateCw aria-hidden="true" />
                  {shared("action.retry")}
                </Button>
              ) : (
                <ButtonLink href={company} variant="primary">
                  {t("get_started.review_company")}
                </ButtonLink>
              )}
              {stage === "stuck" ? (
                skip
              ) : (
                <Button variant="ghost" onClick={finish}>
                  {t("get_started.done")}
                </Button>
              )}
            </div>
            {problem ? (
              <ErrorState module="onboarding" code={problem.code} onRetry={problem.retry} />
            ) : null}
          </div>
        ) : null}
        {readFailure !== undefined ? (
          <ErrorState
            module="onboarding"
            code={readFailure}
            onRetry={() => setReadFailure(undefined)}
          />
        ) : null}
        {ended ? (
          <div className="grid gap-4">
            {icpLine ? (
              <p role="status" className="text-pretty text-ink">
                {icpLine}
              </p>
            ) : null}
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
              {facts
                .filter(([, value]) => value !== "")
                .map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-sm font-medium text-ink-muted">{label}</dt>
                    <dd className="min-w-0 text-pretty text-ink wrap-break-word">{value}</dd>
                  </div>
                ))}
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              <ButtonLink href={company}>{t("get_started.review_company")}</ButtonLink>
              <ButtonLink href={`/w/${workspace}/icp`}>{t("get_started.review_icp")}</ButtonLink>
              <Button variant="primary" onClick={finish}>
                {t("get_started.done")}
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
