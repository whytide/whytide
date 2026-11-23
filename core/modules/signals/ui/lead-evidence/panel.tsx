"use client";
// signals' panel in the evidence slot of contacts' lead page (ui/nav.ts `panels`; README.md
// "Screen"), read in the browser as the member in one call, inside the slot's boundary, with its
// loading state and its error state with a retry: the lead's attribution and the person's events,
// newest first, one line each on a timeline, each after its reaction's icon; an imported lead shows
// the Imported label, "Imported from" its file when the source names it, a lead added by hand Added
// manually (lead-manual-create), and a person without an event the empty state. A reduced event's
// line is a summary from its reaction and date: no text is stored.
import { Badge, EmptyState, ErrorState, Link, LoadingState } from "@whytide/ui";
import {
  Activity,
  ExternalLink,
  Globe,
  type LucideIcon,
  MessageSquare,
  Repeat2,
  ThumbsUp,
} from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { EvidenceResponse } from "../../schemas/evidence.ts";

/** A post link opens only for a web address, never `javascript:` or the like. */
const WEB = /^https?:\/\//i;

/** Each reaction's icon on the timeline; another one's, a pulse. */
const REACTION_ICON: Record<string, LucideIcon> = {
  like: ThumbsUp,
  comment: MessageSquare,
  repost: Repeat2,
};

type Event = EvidenceResponse["events"][number];
type Source = NonNullable<EvidenceResponse["attribution"]>["first"];

export default function LeadEvidence(props: { workspace: string; personId: string }) {
  const { workspace, personId } = props;
  const t = useTranslations("signals.evidence");
  const [loaded, setLoaded] = useState<EvidenceResponse>();
  const [failure, setFailure] = useState<string>();

  const load = useCallback(async () => {
    setFailure(undefined);
    setLoaded(undefined);
    try {
      const params = { path: { workspaceId: workspace, personId } };
      const path = "/v1/workspaces/{workspaceId}/signals/leads/{personId}/evidence";
      setLoaded(await data(browserApi().GET(path, { params })));
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : "internal_error");
    }
  }, [workspace, personId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      aria-labelledby="lead-evidence"
      className="grid content-start gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs"
    >
      <h2 id="lead-evidence" className="font-semibold text-ink">
        {t("title")}
      </h2>
      {failure !== undefined ? (
        <ErrorState module="signals" code={failure} onRetry={load} />
      ) : loaded === undefined ? (
        <LoadingState />
      ) : (
        <Evidence events={loaded.events} attribution={loaded.attribution} />
      )}
    </section>
  );
}

/** The attribution and the lines, as read. */
function Evidence({ events, attribution }: EvidenceResponse) {
  const t = useTranslations("signals.evidence");
  const format = useFormatter();
  const named = (label: string | null) => label ?? t("source_deleted");
  const sourceName = ({ kind, label }: Source) => {
    if (kind === "manual") return t("manual");
    if (kind !== "imported") return named(label);
    return label === null ? t("imported") : t("imported_from", { file: label });
  };
  /** The reaction in words with its author; the author alone for a reaction off the three. */
  const reacted = (reaction: string, author: string) => {
    const words: Record<string, string> = {
      like: t("reaction.like", { author }),
      comment: t("reaction.comment", { author }),
      repost: t("reaction.repost", { author }),
    };
    return words[reaction] ?? author;
  };
  const line = (event: Event) => {
    const found = event.evidence;
    const values = {
      source: named(event.sourceLabel),
      date: format.dateTime(new Date(event.occurredAt), {
        dateStyle: "medium",
        timeStyle: "short",
      }),
      b: (chunks: ReactNode) => <strong className="font-semibold text-ink">{chunks}</strong>,
      time: (chunks: ReactNode) => (
        <time dateTime={event.occurredAt} className="text-ink-muted">
          {chunks}
        </time>
      ),
    };
    if (event.research !== undefined) {
      const { company } = event.research;
      if (event.research.foundBy === "managers" && company !== null) {
        return t.rich("research.found_by_managers", { ...values, company: company.name });
      }
      return company === null
        ? t.rich("research.found_unnamed", values)
        : t.rich("research.found", { ...values, company: company.name });
    }
    if (found === null || found.reducedAt !== null) {
      return t.rich("reduced", { ...values, reaction: found?.reaction ?? "other" });
    }
    const text = found.excerpt ?? found.commentText;
    const action =
      text === null
        ? reacted(found.reaction, found.author)
        : t("comment", { author: found.author, text });
    return t.rich("event", { ...values, action });
  };
  /** An imported lead, or one added by hand, without an event: its source alone, as a badge. */
  const alone =
    events.length === 0 &&
    (attribution?.first.kind === "imported" || attribution?.first.kind === "manual");

  return (
    <>
      {alone ? (
        <p className="flex">
          <Badge>{sourceName(attribution.first)}</Badge>
        </p>
      ) : (
        attribution && (
          <dl className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg bg-muted px-3 py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="text-xs font-medium text-ink-muted">{t("first_source")}</dt>
              <dd className="font-medium text-ink">{sourceName(attribution.first)}</dd>
            </div>
            {attribution.others.length > 0 && (
              <div className="flex flex-wrap items-baseline gap-x-2">
                <dt className="text-xs font-medium text-ink-muted">{t("other_sources")}</dt>
                <dd className="text-ink">
                  {format.list(attribution.others.map(sourceName), { type: "conjunction" })}
                </dd>
              </div>
            )}
          </dl>
        )
      )}
      {events.length > 0 ? (
        <ol className="relative grid gap-5 before:absolute before:inset-y-3 before:start-3 before:w-px before:bg-line">
          {events.map((event) => {
            const Icon =
              event.research === undefined
                ? (REACTION_ICON[event.evidence?.reaction ?? ""] ?? Activity)
                : Globe;
            return (
              <li key={event.id} className="relative grid gap-1 ps-10">
                <span
                  aria-hidden="true"
                  className="absolute start-0 top-0 grid size-6 place-items-center rounded-full bg-accent-soft text-accent-ink ring-4 ring-surface"
                >
                  <Icon className="size-3.5" />
                </span>
                <p className="text-pretty text-ink-muted">{line(event)}</p>
                {event.research !== undefined && <Research research={event.research} />}
                {event.evidence && WEB.test(event.evidence.url) && (
                  <p className="text-sm">
                    <Link href={event.evidence.url} target="_blank" rel="noopener noreferrer">
                      {t("post")}
                      <ExternalLink
                        aria-hidden="true"
                        className="ms-1 inline size-3.5 align-[-0.125em] rtl:-scale-x-100"
                      />
                    </Link>
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyState message={t("empty")} />
      )}
    </>
  );
}

/**
 * A Web research event (gamma-wr-061): the page the person was found on, and the company's reasons with
 * their quotes as the research run kept them, so that the member can check each on its page. Never
 * another person named on the page: the route sends none.
 */
function Research({ research }: { research: NonNullable<Event["research"]> }) {
  const t = useTranslations("signals.evidence");
  const open = (url: string, label: string) =>
    WEB.test(url) && (
      <Link href={url} target="_blank" rel="noopener noreferrer">
        {label}
        <ExternalLink
          aria-hidden="true"
          className="ms-1 inline size-3.5 align-[-0.125em] rtl:-scale-x-100"
        />
      </Link>
    );
  const reasons = research.company?.reasons ?? [];
  return (
    <>
      {research.foundBy === "managers" ? (
        <>
          <p className="text-sm">{open(research.url, t("research.company_site"))}</p>
          <p className="text-xs text-ink-muted">{t("research.managers_by_search")}</p>
          {research.title !== undefined && (
            <p className="text-sm text-ink-muted">
              {t("research.managers_title", { title: research.title })}
            </p>
          )}
        </>
      ) : (
        <p className="text-sm">{open(research.url, t("page"))}</p>
      )}
      {research.foundBy === "search" && (
        <p className="text-xs text-ink-muted">{t("research.profile_by_search")}</p>
      )}
      {reasons.length > 0 && (
        <div className="mt-1 grid gap-2">
          <p className="text-xs font-medium text-ink-muted">{t("research.reasons")}</p>
          {reasons.map((reason, at) => (
            <div key={`${at}-${reason.kind}`} className="grid gap-0.5 text-sm">
              <p className="text-ink">{reason.line}</p>
              <blockquote className="border-s-2 border-line ps-3 text-ink-muted">
                {t("research.quote", { quote: reason.quote })}
              </blockquote>
              <p>{open(reason.url, t("research.reason_page"))}</p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
