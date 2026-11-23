"use client";
// The lead's priority and intent (README "Screen"; F04 §7, §8), in the evidence slot of contacts'
// lead page: the priority, the tier and the intent, then the tier rule applied, from intent-v1's
// numbers; why now, the strongest signal with its date; each signal's share of the intent, newest
// first. A lead with no signal that counts says so in place of the last two. Signals are named by
// their kind and role, never their words; dates and numbers go through the locale's Intl.
import { Badge } from "@whytide/ui";
import { useFormatter, useTranslations } from "next-intl";
import {
  BOOST_POINTS,
  FIT_SHARE_PERCENT,
  HOT_PRIORITY,
  INTENT_SHARE_PERCENT,
  PERCENT,
  WARM_PRIORITY,
} from "../../domain/intent/constants.ts";
import type { SnapshotResponse } from "../../schemas/snapshot.ts";
import { SIGNAL_DATE } from "./constants.ts";

type Intent = NonNullable<SnapshotResponse["intent"]>;
type Signal = Pick<Intent["breakdown"][number], "kind" | "role" | "at">;

const LABEL = "text-ink-muted";
const HEADING = "font-medium text-ink";

export function IntentView({ intent, fit }: { intent: Intent; fit: number }) {
  const t = useTranslations("qualification.intent");
  const format = useFormatter();
  const signal = ({ kind, role, at }: Signal) => {
    const date = at === null ? "" : format.dateTime(new Date(at), SIGNAL_DATE);
    return t("signal", { kind, role, dated: at === null ? "no" : "yes", date });
  };
  const total = intent.breakdown.reduce((sum, { contribution }) => sum + contribution, 0);
  const rule = {
    tier: intent.tier ?? "none",
    ...{ hot: HOT_PRIORITY, warm: WARM_PRIORITY, fit, intent: intent.intentScore },
    ...{ fitShare: FIT_SHARE_PERCENT / PERCENT, intentShare: INTENT_SHARE_PERCENT / PERCENT },
    // The boost's points while the row holds one, else none.
    boost: intent.boostUntil === null ? 0 : BOOST_POINTS,
  };
  return (
    <section
      aria-labelledby="lead-intent"
      className="grid content-start gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs"
    >
      <h2 id="lead-intent" className="font-semibold text-ink">
        {t("title")}
      </h2>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
        <dt className={LABEL}>{t("priority")}</dt>
        <dd className="font-semibold text-ink tabular-nums">{format.number(intent.priority)}</dd>
        {intent.tier && (
          <>
            <dt className={LABEL}>{t("tier")}</dt>
            <dd>
              <Badge tier={intent.tier} />
            </dd>
          </>
        )}
        <dt className={LABEL}>{t("intent")}</dt>
        <dd className="text-ink tabular-nums">{format.number(intent.intentScore)}</dd>
      </dl>
      <p className="text-pretty text-sm text-ink-muted">{t("tier_rule", rule)}</p>
      {intent.whyNow === null ? (
        <p className="text-sm text-ink-muted">{t("no_signal")}</p>
      ) : (
        <>
          <div className="grid gap-1 text-sm">
            <h3 className={HEADING}>{t("why_now")}</h3>
            <p className="text-ink">{signal(intent.whyNow)}</p>
          </div>
          <div className="grid gap-1 text-sm">
            <h3 className={HEADING}>{t("signals")}</h3>
            <ol className="grid gap-1 text-ink">
              {intent.breakdown.map((part) => (
                <li key={part.eventId}>
                  {t("contribution", {
                    signal: signal(part),
                    share: total > 0 ? part.contribution / total : 0,
                  })}
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
    </section>
  );
}
