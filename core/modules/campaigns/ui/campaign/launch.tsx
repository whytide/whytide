"use client";
// The launch panel of a draft (README.md "Screens", "Launch checks"): each check as GET
// …/launch-checks answers it, passing, or failing with its code in words and a link to where it is
// fixed (linkedin's account page, credits' page); Check again, which reads them once more; the price
// of a LinkedIn send in the kit's PriceTag, before Launch; and Launch, enabled once every check
// shown passes, which the api reads again under the campaign's lock. A refusal's checks
// (`details.checks`) replace those shown, in words; one for a campaign launched meanwhile has the
// page read the campaign again. Read-only, for a member who may not change the campaign, Launch is
// off.
import { Button, Card, ErrorState, Link } from "@whytide/ui";
import { CircleCheck, CircleX, RefreshCw, Rocket } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { LAUNCH_CHECK_CODES, LAUNCH_CHECKS } from "../../domain/launch/constants.ts";
import type { LaunchChecksResponse, LaunchResponse } from "../../schemas/campaigns.ts";
import {
  creditsScreen,
  LAUNCH_CHECKS_PATH,
  LAUNCH_CODES,
  LAUNCH_PATH,
  linkedinScreen,
} from "../constants.ts";
import { Price, type PriceEntry } from "./price.tsx";
import { useCampaignWords } from "./words.ts";

type Check = LaunchChecksResponse["checks"][number];
type Props = {
  workspace: string;
  campaignId: string;
  first: Check[];
  price?: PriceEntry;
  /** Another member's campaign, for a member without campaigns.manage: Launch stays off. */
  readOnly: boolean;
  onLaunched: (launched: LaunchResponse) => void;
  /** The campaign is no longer a draft: the page reads it again. */
  onStale: () => void;
};

const known = (list: readonly string[], value: unknown) => list.some((item) => item === value);
/** The checks a refusal names (`details.checks`), those of known checks and codes. */
function checksOf(body: unknown): Check[] | undefined {
  const checks = (body as { details?: { checks?: unknown } } | undefined)?.details?.checks;
  if (!Array.isArray(checks)) return undefined;
  return checks.filter(
    (one): one is Check =>
      typeof one === "object" &&
      one !== null &&
      known(LAUNCH_CHECKS, one.check) &&
      typeof one.ok === "boolean" &&
      (one.code === null || known(LAUNCH_CHECK_CODES, one.code)),
  );
}

export function Launch(props: Props) {
  const { workspace, campaignId, first, price, readOnly, onLaunched, onStale } = props;
  const t = useTranslations("campaigns.launch");
  const words = useCampaignWords();
  const [checks, setChecks] = useState(first);
  const [busy, setBusy] = useState<"check" | "launch">();
  const [failure, setFailure] = useState<string>();
  const params = { path: { workspaceId: workspace, campaignId } };
  const ready = price !== undefined && checks.length > 0 && checks.every(({ ok }) => ok);

  async function check() {
    setBusy("check");
    setFailure(undefined);
    try {
      setChecks((await data(browserApi().GET(LAUNCH_CHECKS_PATH, { params }))).checks);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : new ApiError(500, undefined).code);
    }
    setBusy(undefined);
  }

  async function launch() {
    setBusy("launch");
    setFailure(undefined);
    try {
      const { data: launched, error, response } = await browserApi().POST(LAUNCH_PATH, { params });
      if (response.ok && launched !== undefined) return onLaunched(launched);
      const refusal = new ApiError(response.status, error);
      setFailure(refusal.code);
      if (refusal.code === LAUNCH_CODES.blocked) setChecks(checksOf(error) ?? []);
      if (refusal.code === LAUNCH_CODES.notDraft) onStale();
    } catch {
      setFailure(new ApiError(500, undefined).code);
    }
    setBusy(undefined);
  }

  const fix = (name: Check["check"]) =>
    name === "credits"
      ? { href: creditsScreen(workspace), text: t("fix_credits") }
      : { href: linkedinScreen(workspace), text: t("fix_linkedin") };
  return (
    <Card title={t("title")} description={t("description")}>
      <ul className="grid gap-3">
        {checks.map(({ check: name, ok, code }) => (
          <li key={name} className="flex items-start gap-3">
            {ok ? (
              <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success-ink" />
            ) : (
              <CircleX aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger-ink" />
            )}
            <div className="grid min-w-0 gap-1">
              <span className="font-medium text-ink">{words.check(name)}</span>
              <span className="text-pretty text-sm text-ink-muted">
                {ok || code === null ? t("passed") : words.code(code)}
              </span>
              {ok ? null : (
                <span className="text-sm">
                  <Link href={fix(name).href}>{fix(name).text}</Link>
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {price === undefined ? null : (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted">
          <span>{t("price")}</span>
          <Price price={price} />
        </p>
      )}
      {failure === undefined ? null : <ErrorState module="campaigns" code={failure} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button loading={busy === "check"} disabled={busy === "launch"} onClick={check}>
          <RefreshCw aria-hidden="true" />
          {t("check_again")}
        </Button>
        <Button
          variant="primary"
          loading={busy === "launch"}
          disabled={readOnly || !ready || busy === "check"}
          onClick={launch}
        >
          <Rocket aria-hidden="true" />
          {t("launch")}
        </Button>
      </div>
    </Card>
  );
}
