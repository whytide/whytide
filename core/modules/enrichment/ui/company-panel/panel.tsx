// enrichment's panel in the company slot of contacts' lead page (ui/nav.ts `panels`; README.md "The
// lead page"; gamma-en-055): the company's facts and the lead's country, read in the browser as the
// member through enrichment's own route, each with its value and a line saying where it came from,
// in its source class's words (contacts' `contacts.provenance.source.*`), and when: never a
// vendor's name (RB-7.3.2). An empty field reads "Not found yet", a member's value "Set by a
// member". "Enrich now", for a role holding enrichment.run (who is signed in, GET /v1/me), asks for
// a run with an Idempotency-Key of its own per press, which its retry sends again; while the
// person's run is queued or running the button waits, "Enriching…", and the panel reads the route
// again every POLL_INTERVAL_MS for up to POLL_LIMIT_MS, then stops and offers Refresh. Under the
// fields, the last run's date and how many fields it filled. While it reads, the slot's loading
// state; a failed read, the error state with the code in words and Try again; no company, the empty
// state, the country still shown.
"use client";

import { Button, Card, EmptyState, ErrorState, LoadingState } from "@whytide/ui";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelField } from "../../domain/lead/constants.ts";
import { RUN_ROLES, WORKING_STATUSES } from "../../domain/lead/constants.ts";
import type { LeadEnrichmentResponse } from "../../schemas/lead.ts";
import { DATE_FORMAT, LEAD_PATH, POLL_INTERVAL_MS, POLL_LIMIT_MS } from "./constants.ts";

type Answer = LeadEnrichmentResponse & { readonly canRun: boolean };
type Read = Answer | { readonly failed: string };
type Fields = NonNullable<LeadEnrichmentResponse["company"]>["fields"];
type Shown = { value: string | number | null; sourceClass: string | null; at: string | null };
const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");
const MEMBER = "member";

export default function CompanyPanel(props: { workspace: string; personId: string }) {
  const { workspace, personId } = props;
  const t = useTranslations("enrichment.company_panel");
  const format = useFormatter();
  const [read, setRead] = useState<Read>();
  /** Raised by Try again, which reads once more. */
  const [attempt, setAttempt] = useState(0);
  const [pressing, setPressing] = useState(false);
  const [refused, setRefused] = useState<{ code: string; retry: () => void }>();
  /** When the panel began reading again for the run at work; null while none works. */
  const pollSince = useRef<number | null>(null);
  const [pollEnded, setPollEnded] = useState(false);

  const load = useCallback(async (): Promise<Answer> => {
    const params = { path: { workspaceId: workspace, personId } };
    const [answer, me] = await Promise.all([
      data(browserApi().GET(LEAD_PATH, { params })),
      data(browserApi().GET("/v1/me")),
    ]);
    const role = me.memberships.find(
      ({ workspaceId, slug }) => workspaceId === workspace || slug === workspace,
    )?.role;
    return { ...answer, canRun: RUN_ROLES.some((allowed) => allowed === role) };
  }, [workspace, personId]);

  // One read per person, workspace and attempt; an earlier one that answers late is dropped.
  useEffect(() => {
    let live = true;
    setRead(undefined);
    load().then(
      (answer) => live && setRead(answer),
      (error: unknown) => live && setRead({ failed: codeOf(error) }),
    );
    return () => {
      live = false;
    };
  }, [load, attempt]);

  const reload = useCallback(
    () => load().then(setRead, (error: unknown) => setRead({ failed: codeOf(error) })),
    [load],
  );
  const status = read && !("failed" in read) ? read.lastRun?.status : undefined;
  const working = WORKING_STATUSES.some((busy) => busy === status);

  // While the run works: read again every POLL_INTERVAL_MS, up to POLL_LIMIT_MS, then stop.
  useEffect(() => {
    if (!working) {
      pollSince.current = null;
      return;
    }
    if (pollEnded) return;
    pollSince.current ??= Date.now();
    if (Date.now() - pollSince.current >= POLL_LIMIT_MS) {
      setPollEnded(true);
      return;
    }
    const timer = setTimeout(() => void reload(), POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [read, working, pollEnded, reload]);

  /** Refresh, once the panel stopped reading: read again, and poll anew while the run works. */
  const refresh = () => {
    pollSince.current = null;
    setPollEnded(false);
    void reload();
  };

  /** "Enrich now": one key per press, which its retry sends again; then the panel reads again. */
  async function enrich(key = crypto.randomUUID()) {
    setPressing(true);
    setRefused(undefined);
    try {
      const params = {
        path: { workspaceId: workspace, personId },
        header: { "Idempotency-Key": key },
      };
      await data(browserApi().POST(LEAD_PATH, { params }));
      pollSince.current = null;
      setPollEnded(false);
      await reload();
    } catch (error) {
      setRefused({ code: codeOf(error), retry: () => void enrich(key) });
    } finally {
      setPressing(false);
    }
  }

  if (read === undefined) return <LoadingState />;
  if ("failed" in read) {
    return (
      <Card title={t("title")}>
        <ErrorState
          module="enrichment"
          code={read.failed}
          onRetry={() => setAttempt((count) => count + 1)}
        />
      </Card>
    );
  }
  const { company, person, lastRun, canRun } = read;
  const finished = lastRun?.finishedAt ?? null;
  const action = canRun ? (
    <Button size="sm" onClick={() => void enrich()} loading={pressing} disabled={working}>
      {working ? t("enriching") : t("enrich_now")}
    </Button>
  ) : undefined;
  return (
    <Card title={t("title")} actions={action}>
      {refused && <ErrorState module="enrichment" code={refused.code} onRetry={refused.retry} />}
      {company === null ? (
        <EmptyState message={t("no_company")} />
      ) : (
        <Facts name={company.name} fields={company.fields} />
      )}
      <dl>
        <div className="grid gap-1">
          <dt className="text-sm text-ink-muted">{t("field.person_country")}</dt>
          <Value field="country" shown={person.country} />
        </div>
      </dl>
      <p className="text-sm text-ink-muted">
        {finished
          ? t("last_enriched", {
              date: format.dateTime(new Date(finished), DATE_FORMAT),
              count: lastRun?.filled.length ?? 0,
            })
          : t("not_enriched")}
      </p>
      {finished && lastRun && lastRun.outcomes.length > 0 && (
        <Outcomes outcomes={lastRun.outcomes} />
      )}
      {working && pollEnded && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
          {t("still_working")}
          <Button size="sm" variant="ghost" onClick={refresh}>
            {t("refresh")}
          </Button>
        </p>
      )}
    </Card>
  );
}

/** The company's name, then each field with its value and where it came from. */
function Facts(props: { name: string; fields: Fields }) {
  const t = useTranslations("enrichment.company_panel");
  const labels = useFieldLabels();
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      <div className="grid gap-1 sm:col-span-2">
        <dt className="text-sm text-ink-muted">{t("field.name")}</dt>
        <dd className="font-medium text-ink">{props.name}</dd>
      </div>
      {props.fields.map((shown) => (
        <div key={shown.field} className="grid min-w-0 gap-1">
          <dt className="text-sm text-ink-muted">{labels[shown.field]}</dt>
          <Value field={shown.field} shown={shown} />
        </div>
      ))}
    </dl>
  );
}

/** A value and its line: "Not found yet", "Set by a member" with the date, or the class and date. */
function Value({ field, shown }: { field: PanelField; shown: Shown | null }) {
  const t = useTranslations("enrichment.company_panel");
  const label = useSourceLabel();
  const format = useFormatter();
  const locale = useLocale();
  if (shown === null || shown.value === null) {
    return <dd className="text-ink-subtle">{t("not_found")}</dd>;
  }
  const { value, sourceClass, at } = shown;
  const text =
    typeof value === "number"
      ? format.number(value)
      : field === "country"
        ? (regionName(locale, value) ?? value)
        : value;
  const date = at === null ? null : format.dateTime(new Date(at), DATE_FORMAT);
  const line =
    sourceClass === MEMBER
      ? date === null
        ? t("set_by_member")
        : t("set_by_member_at", { date })
      : date === null
        ? label(sourceClass)
        : t("provenance", { source: label(sourceClass), date });
  return (
    <dd className="grid min-w-0 gap-0.5">
      <span className="break-words text-ink">{text}</span>
      <small className="text-xs text-ink-subtle">{line}</small>
    </dd>
  );
}

/** What the last run's sources answered, in words, each once: never a source's name (RB-7.3.2). */
function Outcomes({ outcomes }: { outcomes: readonly string[] }) {
  const t = useTranslations("enrichment.company_panel");
  const word = useOutcomeWord();
  return (
    <p className="text-sm text-ink-muted">
      {t("outcomes", { outcomes: outcomes.map(word).join(" · ") })}
    </p>
  );
}

/**
 * An outcome's words (`enrichment.outcome.*`): en-050's, the web-search source's, the linkedin
 * source's, country-ai's, the linkedin-contact-info email source's (gamma-en-087) and the free
 * email sources' (gamma-en-085); a later source's own outcome reads "other" until its task adds its
 * words here.
 */
function useOutcomeWord(): (outcome: string) => string {
  const t = useTranslations("enrichment.outcome");
  return (outcome) => {
    switch (outcome) {
      case "found":
        return t("found");
      case "not_found":
        return t("not_found");
      case "no_company_key":
        return t("no_company_key");
      case "allowance_spent":
        return t("allowance_spent");
      case "failed":
        return t("failed");
      case "not_a_company":
        return t("not_a_company");
      case "ambiguous":
        return t("ambiguous");
      case "no_adapter":
        return t("no_adapter");
      case "no_account":
        return t("no_account");
      case "no_reads_left":
        return t("no_reads_left");
      case "no_place":
        return t("no_place");
      case "not_sure":
        return t("not_sure");
      case "unknown_country":
        return t("unknown_country");
      case "ai_failed":
        return t("ai_failed");
      case "disabled":
        return t("disabled");
      case "not_connected":
        return t("not_connected");
      // The free email sources' (gamma-en-085).
      case "catch_all_domain":
        return t("catch_all_domain");
      case "pattern_found":
        return t("pattern_found");
      case "no_guess":
        return t("no_guess");
      default:
        return t("other");
    }
  };
}

/** A country's name in the page's language, from its code; undefined for a code it does not know. */
function regionName(locale: string, code: string): string | undefined {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code);
  } catch {
    return undefined;
  }
}

/** The fields' labels, each a key of its own. */
function useFieldLabels(): Record<PanelField, string> {
  const t = useTranslations("enrichment.company_panel");
  return {
    domain: t("field.domain"),
    linkedinUrl: t("field.linkedin_url"),
    industry: t("field.industry"),
    sizeRange: t("field.size_range"),
    employeeCount: t("field.employee_count"),
    country: t("field.country"),
    description: t("field.description"),
  };
}

/** A source class's words (`contacts.provenance.source.*`), never its provider's name (RB-7.3.2). */
function useSourceLabel(): (source: string | null) => string {
  const t = useTranslations("contacts.provenance.source");
  return (source) => {
    switch (source) {
      case "linkedin":
        return t("linkedin");
      case "import":
        return t("import");
      case "website":
        return t("website");
      case "open_data":
        return t("open_data");
      case "data_vendor":
        return t("data_vendor");
      case "web_search":
        return t("web_search");
      case "ai_inferred":
        return t("ai_inferred");
      default:
        return t("other");
    }
  };
}
