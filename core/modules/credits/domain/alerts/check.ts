// The check (README "Alerts"; docs/flows.md "The credit alerts"), credits_check_alerts' work, global,
// as `app` across organizations: the share of every organization whose period holds `at`, and a row
// for each threshold it reached, inserted with ON CONFLICT DO NOTHING on the "once per threshold per
// period" key, so two checks at once insert one row per threshold. Then the alerts to mail, by
// organization: the highest of the current period's rows whose mail has not gone and whose tries are
// under CREDIT_ALERT_MAX_TRIES, a new row included; the lower ones go with its mail (mail.ts), so a
// check that crosses several thresholds sends one mail. A past period's rows are never answered.
import { newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import { inGlobal } from "../store.ts";
import { CREDIT_ALERT_MAX_TRIES } from "./constants.ts";
import { alertShare, periodFigures } from "./share.ts";

/** What a check did, counted, and the alerts to mail, one per organization at most: ids only. */
export type AlertCheck = {
  /** The organizations whose subscription's period holds the check's instant. */
  readonly organizations: number;
  /** The rows this check inserted. */
  readonly recorded: number;
  readonly alertIds: readonly string[];
};

/** The check as of `at`, the workflow's start: the rows reached, then the alerts to mail. */
export function checkAlerts(at: Date): Promise<AlertCheck> {
  return inGlobal("alerts", async (db, app) => {
    const figures = await periodFigures(app, at);
    const data = figures.flatMap(({ organizationId, periodStart, used, granted }) => {
      const reached = alertShare(used, granted)?.reached ?? [];
      return reached.map((threshold) => {
        const id = newId(ids.credit_alert);
        return { id, organizationId, periodStart, threshold, used, granted };
      });
    });
    const recorded =
      data.length === 0
        ? 0
        : (await db.creditAlert.createMany({ data, skipDuplicates: true })).count;
    const due = await app.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT ON (a.organization_id) a.id
      FROM credit_alerts a
        JOIN subscriptions s ON s.organization_id = a.organization_id
          AND s.period_start = a.period_start
      WHERE a.notified_at IS NULL AND a.tries < ${CREDIT_ALERT_MAX_TRIES}
        AND s.period_start <= ${at}::timestamptz AND s.period_end > ${at}::timestamptz
      ORDER BY a.organization_id, a.threshold DESC`;
    return { organizations: figures.length, recorded, alertIds: due.map(({ id }) => id) };
  });
}
