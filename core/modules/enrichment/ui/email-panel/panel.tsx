// enrichment's Email panel in the company slot of contacts' lead page, under the company panel
// (ui/nav.ts `panels`; README.md "The Email panel"; gamma-en-081): the lead's held address, read in
// the browser as the member through enrichment's own route, with its kind, its source class in words
// and its verification and date, never a finder's or verifier's name (RB-7.3.2); a personal address
// that waits for the lead's consent (the owner's UK and EU switch) reads as not used, with why.
// Without an address, the last lookup's end in words, or the line that one comes 24 hours before
// the first email step. For a role holding enrichment.run (GET /v1/me): "Find email", its price
// first in the kit's PriceTag (credits' price list), or "Verify again", free, for a held address;
// each press posts with an Idempotency-Key of its own, which its retry sends again. While the
// lookup is queued or running the button waits, "Looking up…", and the panel reads the route again
// as the company panel does, then stops and offers Refresh. The kit's loading and error states.
"use client";

import { Button, Card, ErrorState, LoadingState, PriceTag } from "@whytide/ui";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EmailAction } from "../../domain/lead/constants.ts";
import { RUN_ROLES, WORK_EMAIL_ACTION, WORKING_STATUSES } from "../../domain/lead/constants.ts";
import type { MissingReason, Verdict } from "../../domain/lookup/constants.ts";
import type { LeadEmailResponse, LeadPhonesResponse } from "../../schemas/email.ts";
import { DATE_FORMAT, POLL_INTERVAL_MS, POLL_LIMIT_MS } from "../company-panel/constants.ts";
import { EMAIL_PATH, PHONES_PATH, PRICES_PATH } from "./constants.ts";

/** The price of a lookup as credits' list answers it: credits per unit, and a coming change. */
type Price = {
  readonly credits: string;
  readonly unit: string;
  readonly next: {
    readonly credits: string;
    readonly unit: string;
    readonly effectiveFrom: string;
  } | null;
};
type Answer = LeadEmailResponse &
  LeadPhonesResponse & { readonly canRun: boolean; readonly price: Price | null };
type Read = Answer | { readonly failed: string };
type Held = NonNullable<LeadEmailResponse["email"]>;
const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");

export default function EmailPanel(props: { workspace: string; personId: string }) {
  const { workspace, personId } = props;
  const t = useTranslations("enrichment.email_panel");
  const format = useFormatter();
  const reasonWord = useReasonWord();
  const [read, setRead] = useState<Read>();
  /** Raised by Try again, which reads once more. */
  const [attempt, setAttempt] = useState(0);
  const [pressing, setPressing] = useState(false);
  const [refused, setRefused] = useState<{ code: string; retry: () => void }>();
  /** When the panel began reading again for the lookup at work; null while none works. */
  const pollSince = useRef<number | null>(null);
  const [pollEnded, setPollEnded] = useState(false);

  const load = useCallback(async (): Promise<Answer> => {
    const path = { workspaceId: workspace, personId };
    const [answer, { phones }, me, { prices }] = await Promise.all([
      data(browserApi().GET(EMAIL_PATH, { params: { path } })),
      data(browserApi().GET(PHONES_PATH, { params: { path } })),
      data(browserApi().GET("/v1/me")),
      data(browserApi().GET(PRICES_PATH, { params: { path: { workspaceId: workspace } } })),
    ]);
    const role = me.memberships.find(
      ({ workspaceId, slug }) => workspaceId === workspace || slug === workspace,
    )?.role;
    const price = prices.find(({ action }) => action === WORK_EMAIL_ACTION) ?? null;
    return { ...answer, phones, price, canRun: RUN_ROLES.some((allowed) => allowed === role) };
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
  const status = read && !("failed" in read) ? read.lastLookup?.status : undefined;
  const working = WORKING_STATUSES.some((busy) => busy === status);

  // While the lookup works: read again every POLL_INTERVAL_MS, up to POLL_LIMIT_MS, then stop.
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

  /** Refresh, once the panel stopped reading: read again, and poll anew while the lookup works. */
  const refresh = () => {
    pollSince.current = null;
    setPollEnded(false);
    void reload();
  };

  /** "Find email" or "Verify again": one key per press, which its retry sends again. */
  async function ask(action: EmailAction, key = crypto.randomUUID()) {
    setPressing(true);
    setRefused(undefined);
    try {
      const params = {
        path: { workspaceId: workspace, personId },
        header: { "Idempotency-Key": key },
      };
      await data(browserApi().POST(EMAIL_PATH, { params, body: { action } }));
      pollSince.current = null;
      setPollEnded(false);
      await reload();
    } catch (error) {
      setRefused({ code: codeOf(error), retry: () => void ask(action, key) });
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
  const { email, phones, lastLookup, canRun, price } = read;
  const press = (action: EmailAction, label: string) => (
    <Button size="sm" onClick={() => void ask(action)} loading={pressing} disabled={working}>
      {working ? t("looking_up") : label}
    </Button>
  );
  const action = !canRun ? undefined : email ? (
    press("verify", t("verify_again"))
  ) : (
    <span className="inline-flex flex-wrap items-center gap-2">
      {price && <LookupPrice price={price} />}
      {press("find", t("find"))}
    </span>
  );
  // The last lookup's end, when it ended without an address: its date and why.
  const why =
    !working && lastLookup?.reason && lastLookup.finishedAt
      ? { reason: lastLookup.reason, date: new Date(lastLookup.finishedAt) }
      : null;
  return (
    <Card title={t("title")} actions={action}>
      {refused && <ErrorState module="enrichment" code={refused.code} onRetry={refused.retry} />}
      {email ? (
        <Address email={email} />
      ) : (
        <p className="text-sm text-ink-muted">
          {lastLookup ? t("no_address") : t("not_looked_up")}
        </p>
      )}
      {phones.length > 0 && <Phones phones={phones} />}
      {why && (
        <p className="text-sm text-ink-muted">
          {t("last_lookup", {
            date: format.dateTime(why.date, DATE_FORMAT),
            reason: reasonWord(why.reason),
          })}
        </p>
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

/** The held address, its kind and class, and its verification with its date; or why it is unused. */
function Address({ email }: { email: Held }) {
  const t = useTranslations("enrichment.email_panel");
  const format = useFormatter();
  const source = useSourceWord();
  const verdict = useVerdictWord();
  const date = format.dateTime(new Date(email.verifiedAt), DATE_FORMAT);
  const kind = email.kind === "work_email" ? t("kind.work_email") : t("kind.personal_email");
  return (
    <div className="grid min-w-0 gap-1">
      <span className="break-words font-medium text-ink">{email.address}</span>
      <small className="text-xs text-ink-subtle">
        {t("provenance", { kind, source: source(email.sourceClass) })}
      </small>
      <small className="text-xs text-ink-subtle">
        {email.verification === "valid"
          ? t("verified", { date })
          : t("checked", { date, verdict: verdict(email.verification) })}
      </small>
      {email.needsConsent && (
        <p className="text-sm text-ink-muted">{t("personal_needs_consent")}</p>
      )}
    </div>
  );
}

/**
 * The numbers a public page printed with the lead, each with the page that printed it, a link that
 * opens in a tab of its own with no opener (gamma-wr-100). A number is text: Whytide calls and
 * messages none. A page's address that is not http or https is not linked.
 */
function Phones({ phones }: { phones: LeadPhonesResponse["phones"] }) {
  const t = useTranslations("enrichment.email_panel");
  return (
    <div className="grid min-w-0 gap-2">
      <h3 className="text-sm font-medium text-ink-muted">{t("phones_title")}</h3>
      <ul className="grid min-w-0 gap-2">
        {phones.map(({ number, page }) => {
          const url = page === null ? null : URL.parse(page);
          return (
            <li key={number} className="grid min-w-0 gap-1">
              <span className="break-words font-medium text-ink">{number}</span>
              <small className="text-xs text-ink-subtle">
                {url !== null && (url.protocol === "https:" || url.protocol === "http:") ? (
                  <a
                    href={url.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-words underline"
                  >
                    {t("phone_printed_on", { host: url.host })}
                  </a>
                ) : (
                  t("phone_no_page")
                )}
              </small>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The price of a lookup in the kit's PriceTag, its unit in the panel's words. */
function LookupPrice({ price: { credits, unit, next } }: { price: Price }) {
  const t = useTranslations("enrichment.email_panel");
  // One unit, `email` (prices.ts); a coming change to another unit shows the price as it stands.
  const coming = next && next.unit === unit ? next : undefined;
  return <PriceTag credits={credits} unit={t("price_unit")} next={coming} />;
}

/** Why a lookup ended without an address (MISSING_REASONS), each in its own words. */
function useReasonWord(): (reason: MissingReason) => string {
  const t = useTranslations("enrichment.email_panel.reason");
  return (reason) => {
    switch (reason) {
      case "suppressed":
        return t("suppressed");
      case "no_name":
        return t("no_name");
      case "no_domain":
        return t("no_domain");
      case "catch_all":
        return t("catch_all");
      case "not_verified":
        return t("not_verified");
      case "no_result":
        return t("no_result");
      case "other_domain":
        return t("other_domain");
      case "held_by_other_person":
        return t("held_by_other_person");
      case "cached_negative":
        return t("cached_negative");
      case "insufficient_credits":
        return t("insufficient_credits");
      case "provider_error":
        return t("provider_error");
      case "no_address":
        return t("no_address");
      case "no_verifier_left":
        return t("no_verifier_left");
      case "personal_needs_consent":
        return t("personal_needs_consent");
      case "bounced":
        return t("bounced");
    }
  };
}

/** A verifier's verdict other than valid, in words. */
function useVerdictWord(): (verdict: Verdict) => string {
  const t = useTranslations("enrichment.email_panel.verdict");
  return (verdict) => {
    switch (verdict) {
      case "valid":
        return t("valid");
      case "catch_all":
        return t("catch_all");
      case "risky":
        return t("risky");
      case "invalid":
        return t("invalid");
      case "unknown":
        return t("unknown");
    }
  };
}

/**
 * A contact point's class in words, never its provider's name (RB-7.3.2): the finders' class and
 * the lead's LinkedIn Contact info (gamma-en-087), the lead's reply, the company's website and the
 * address pattern (gamma-en-085), a page's printed address (gamma-wr-070); a later source's class reads "another source" until its task adds
 * its words here.
 */
function useSourceWord(): (sourceClass: string) => string {
  const t = useTranslations("enrichment.email_panel.source");
  return (sourceClass) => {
    switch (sourceClass) {
      case "email_finder":
        return t("email_finder");
      case "linkedin_contact_info":
        return t("linkedin_contact_info");
      // The free email sources' classes (gamma-en-085).
      case "lead_reply":
        return t("lead_reply");
      case "website":
        return t("website");
      case "pattern":
        return t("pattern");
      // An address a company's page printed with the person (gamma-wr-070).
      case "page_printed":
        return t("page_printed");
      default:
        return t("other");
    }
  };
}
