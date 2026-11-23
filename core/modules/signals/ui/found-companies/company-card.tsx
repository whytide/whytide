"use client";
// One found company on the Companies found screen (README.md "Screen"; gamma-wr-111), a card: its name
// and site, its verdict (a member's own says so, and by whom the api answers), where it is, each reason
// as stored (what it shows, its line, its quote and its page as a link, the date read), the page that
// led to it and its source type, how to reach it (the general address, the phones, the postal address),
// the leads found there, the source's label and the date; and Not a fit, for a member who may write the
// source. Every link out opens in a new tab and gives no referrer, `rel="noopener noreferrer"`, and only
// an http(s) address is a link: a page's address is the web's words, not ours.
import { Badge, type BadgeTone, Button, Card, Link } from "@whytide/ui";
import { Ban, ExternalLink, Users } from "@whytide/ui/icons";
import { useTranslations } from "next-intl";
import type { ReasonKind, Verdict } from "../../domain/research/constants.ts";
import type { FoundCompanyResponse } from "../../schemas/found-companies.ts";
import { When } from "../sources/when.tsx";
import { LEADS_SHOWN, SOURCE_TYPES, type SourceType } from "./constants.ts";

export type Company = FoundCompanyResponse;

const TONES: Record<Verdict, BadgeTone> = { fit: "success", unsure: "warning", not_fit: "neutral" };

/** An address a link may take: http or https; any other is shown as text. */
const webAddress = (address: string): boolean => /^https?:\/\//i.test(address);

/** The words of one reason's page: its host, which says where without the whole address. */
function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

export function CompanyCard(props: {
  company: Company;
  /** The member may write the company's source: Not a fit is theirs to press. */
  writable: boolean;
  onNotFit: (company: Company) => void;
}) {
  const { company, writable, onNotFit } = props;
  const t = useTranslations("signals.found");
  const types = useTranslations("signals.places");
  const verdictText: Record<Verdict, string> = {
    fit: t("verdict.fit"),
    unsure: t("verdict.unsure"),
    not_fit: t("verdict.not_fit"),
  };
  const kindText: Record<ReasonKind, string> = {
    focus: t("reason.focus"),
    must_have: t("reason.must_have"),
    disqualifier: t("reason.disqualifier"),
    industry: t("reason.industry"),
    size: t("reason.size"),
    country: t("reason.country"),
  };
  const typeText: Record<SourceType, string> = {
    association_members: types("association_members.label"),
    contracts_awarded: types("contracts_awarded.label"),
    customer_sites: types("customer_sites.label"),
    dealer_lists: types("dealer_lists.label"),
    distributor_lists: types("distributor_lists.label"),
    fair_exhibitors: types("fair_exhibitors.label"),
    public_tenders: types("public_tenders.label"),
    supplier_registries: types("supplier_registries.label"),
    web_search: types("web_search.label"),
  };
  const external = (href: string, words: string) =>
    webAddress(href) ? (
      <Link href={href} target="_blank" rel="noopener noreferrer">
        {words}
        <ExternalLink
          aria-hidden="true"
          className="ms-1 inline size-3.5 align-[-0.125em] rtl:-scale-x-100"
        />
      </Link>
    ) : (
      <span className="wrap-anywhere">{words}</span>
    );
  const place = [company.town, company.state, company.country].filter(Boolean).join(", ");
  const type = SOURCE_TYPES.find((id) => id === company.placeId);
  const reach = [company.email, ...company.phones, company.postalAddress].filter(
    (line): line is string => line !== null && line !== "",
  );
  const leadNames = company.leads.slice(0, LEADS_SHOWN);
  const more = company.leadCount - leadNames.length;
  return (
    <li className="list-none">
      <Card
        level={3}
        title={company.name}
        actions={
          <Badge tone={TONES[company.verdict]}>
            {company.markedByMember
              ? t("verdict.by_member", { verdict: verdictText[company.verdict] })
              : verdictText[company.verdict]}
          </Badge>
        }
      >
        <p className="flex min-w-0 flex-wrap gap-x-3 wrap-anywhere text-ink-muted">
          {external(company.website, company.domain)}
          {place ? <span>{place}</span> : null}
        </p>
        {company.reasons.length > 0 ? (
          <ul className="grid gap-3">
            {company.reasons.map((reason) => (
              <li
                key={`${reason.kind}-${reason.criterion ?? ""}-${reason.url}-${reason.quote}`}
                className="grid gap-1 border-s-2 border-line ps-3"
              >
                <p className="font-medium">
                  {kindText[reason.kind]}
                  {reason.criterion ? (
                    <span className="ms-2 text-ink-muted">{reason.criterion}</span>
                  ) : null}
                  <span className="ms-2 text-xs font-normal text-ink-muted">
                    {reason.answer === "shown" ? t("reason.shown") : t("reason.contradicted")}
                  </span>
                </p>
                <p>{reason.line}</p>
                <blockquote className="wrap-anywhere text-ink-muted">
                  <q>{reason.quote}</q>
                </blockquote>
                <p className="flex min-w-0 flex-wrap gap-x-3 wrap-anywhere text-sm">
                  {external(reason.url, hostOf(reason.url))}
                  <span className="text-ink-muted">{t("reason.read_at")}</span>
                  <When at={reason.readAt} />
                </p>
              </li>
            ))}
          </ul>
        ) : null}
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
          <dt className="text-ink-muted">{t("found_on")}</dt>
          <dd className="min-w-0 wrap-anywhere">
            {external(company.pageUrl, hostOf(company.pageUrl))}
            {type ? <span className="ms-3 text-ink-muted">{typeText[type]}</span> : null}
          </dd>
          <dt className="text-ink-muted">{t("reach")}</dt>
          <dd className="min-w-0 wrap-anywhere">
            {reach.length > 0 ? (
              <ul className="grid gap-0.5">
                {reach.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : (
              <span className="text-ink-muted">{t("reach_none")}</span>
            )}
          </dd>
          <dt className="text-ink-muted">{t("leads")}</dt>
          <dd className="min-w-0 wrap-anywhere">
            {company.leadCount === 0 ? (
              <span className="text-ink-muted">{t("leads_none")}</span>
            ) : (
              <>
                <Users aria-hidden="true" className="me-1 inline size-3.5 align-[-0.125em]" />
                {leadNames
                  .map(({ name, title }) => [name, title].filter(Boolean).join(", "))
                  .filter((line) => line !== "")
                  .join("; ")}
                {more > 0 ? (
                  <span className="ms-2 text-ink-muted">{t("leads_more", { count: more })}</span>
                ) : null}
              </>
            )}
          </dd>
          <dt className="text-ink-muted">{t("source")}</dt>
          <dd className="min-w-0 wrap-anywhere">{company.sourceLabel}</dd>
          <dt className="text-ink-muted">{t("judged")}</dt>
          <dd>
            <When at={company.judgedAt} />
          </dd>
        </dl>
        {writable && company.verdict !== "not_fit" ? (
          <footer className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button
              variant="ghost"
              aria-label={t("not_fit_of", { name: company.name })}
              onClick={() => onNotFit(company)}
            >
              <Ban aria-hidden="true" />
              {t("not_fit")}
            </Button>
          </footer>
        ) : null}
      </Card>
    </li>
  );
}
