// The share of the period's granted credits an organization has used (README "Alerts"): for each
// organization whose subscription's period holds the check's instant, `granted` is the sum of the
// grants of that period and `used` the sum of the usage reserved or committed, created in it; the
// share is used ÷ granted, in percent. Credits carried over from earlier periods count in neither,
// so the 100 percent alert can go while credits are left. A period with no grant, or a grant of 0,
// has no share and raises no alert. The figures are summed in Postgres numeric, the share exactly.
import type { PrismaClient } from "@whytide/db";
import { settings } from "../../settings.ts";
import { percentOf } from "../costs/decimal.ts";

/** An organization's current period and its figures, as decimal strings. */
export type PeriodFigures = {
  readonly organizationId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly used: string;
  readonly granted: string;
};

/**
 * The share in percent, cut at the 30th decimal, and the thresholds it reached, lowest first: those
 * of CREDITS_ALERT_THRESHOLDS (settings.ts, README "Settings").
 */
export type AlertShare = {
  readonly percent: string;
  readonly reached: readonly number[];
};

/**
 * The share of `granted` that `used` is, and the thresholds it reached; null for a grant of 0. The
 * percent is cut, never rounded, so 79.99… reaches nothing: its whole part decides, exactly.
 */
export function alertShare(used: string, granted: string): AlertShare | null {
  const percent = percentOf(used, granted);
  if (percent === null) return null;
  const whole = BigInt(percent.split(".")[0] ?? "0");
  const thresholds = settings.CREDITS_ALERT_THRESHOLDS;
  return { percent, reached: thresholds.filter((t) => whole >= BigInt(t)) };
}

/**
 * Every organization whose subscription's period holds `at`, with the figures of that period, by
 * organization. Read as `app` across organizations, as the period pass reads the subscriptions.
 */
export function periodFigures(
  app: Pick<PrismaClient, "$queryRaw">,
  at: Date,
): Promise<PeriodFigures[]> {
  return app.$queryRaw<PeriodFigures[]>`
    SELECT s.organization_id AS "organizationId", s.period_start AS "periodStart",
      s.period_end AS "periodEnd",
      trim_scale(COALESCE((SELECT sum(u.credits) FROM credit_usage u
        WHERE u.organization_id = s.organization_id AND u.status IN ('reserved', 'committed')
          AND u.created_at >= s.period_start AND u.created_at < s.period_end), 0))::text AS used,
      trim_scale(COALESCE((SELECT sum(g.amount) FROM credit_grants g
        WHERE g.organization_id = s.organization_id AND g.period_start = s.period_start), 0))::text
        AS granted
    FROM subscriptions s
    WHERE s.period_start <= ${at}::timestamptz AND s.period_end > ${at}::timestamptz
    ORDER BY s.organization_id`;
}
