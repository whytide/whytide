"use client";
// The costs page in the browser (README.md "Screens"): the organization's balance, large, and its
// period's end, with a bar of the period's grant, spent then reserved; then the week the picker
// names, one of the last twelve ISO weeks in UTC: the credits spent, the vendors' cost, the leads
// qualified and the cost per 100 of them, by action and by vendor, each amount with a bar of its
// share, and the week's usage a page at a time. Read through the web's API client, with the loading
// state, the error state with the code in words and a retry, and the empty state of a week with
// nothing spent.
import {
  Badge,
  type BadgeTone,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  Meter,
  Select,
  Skeleton,
} from "@whytide/ui";
import { Info } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { recentWeeks, type Week } from "../../domain/costs/week.ts";
import type { CostsResponse } from "../../schemas/costs.ts";
import type { BalanceResponse, UsageResponse } from "../../schemas/credits.ts";
import { AMOUNT } from "../amount.ts";
import { LOADING_TILES } from "./constants.ts";

type Loaded = {
  readonly balance: BalanceResponse;
  readonly costs: CostsResponse;
  readonly usage: UsageResponse;
  /** The cursor of the usage page shown, and of the pages before it, the first page's undefined. */
  readonly cursor?: string;
  readonly before: readonly (string | undefined)[];
};
type Usage = UsageResponse["items"][number];

const WEEKS = 12;
const PAGE = 20;
const CARD = "rounded-xl border border-line bg-surface p-5 shadow-xs";
const TILE = "grid content-start gap-1.5 rounded-xl border border-line bg-surface p-4 shadow-xs";
/** A usage row's status as a badge: spent, still reserved, or given back. */
const STATUS_TONE: Record<Usage["status"], BadgeTone> = {
  committed: "success",
  reserved: "warning",
  released: "neutral",
  expired: "neutral",
};
const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");

export function CostsScreen({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("credits.screen");
  const format = useFormatter();
  const [weeks] = useState(() => recentWeeks(new Date(), WEEKS));
  const [week, setWeek] = useState<Week | undefined>(weeks[0]);
  const [loaded, setLoaded] = useState<Loaded>();
  const [failure, setFailure] = useState<string>();

  const readUsage = useCallback(
    (cursor: string | undefined) => {
      const from = week?.start.toISOString();
      const to = week?.end.toISOString();
      const query = { from, to, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) };
      const params = { path: { workspaceId }, query };
      return data(browserApi().GET("/v1/workspaces/{workspaceId}/credits/usage", { params }));
    },
    [workspaceId, week],
  );

  /** The first read, a week picked and the retry: the loading state, then the screen. */
  const open = useCallback(async () => {
    setFailure(undefined);
    setLoaded(undefined);
    try {
      const api = browserApi();
      const path = { workspaceId };
      const query = { week: week?.week };
      const [balance, costs, usage] = await Promise.all([
        data(api.GET("/v1/workspaces/{workspaceId}/credits/balance", { params: { path } })),
        data(api.GET("/v1/workspaces/{workspaceId}/credits/costs", { params: { path, query } })),
        readUsage(undefined),
      ]);
      setLoaded({ balance, costs, usage, before: [] });
    } catch (error) {
      setFailure(codeOf(error));
    }
  }, [workspaceId, week, readUsage]);

  useEffect(() => {
    void open();
  }, [open]);

  /** Another usage page, the cursors before it kept for Previous. */
  const turn = async (cursor: string | undefined, before: readonly (string | undefined)[]) => {
    try {
      const usage = await readUsage(cursor);
      setLoaded((shown) => shown && { ...shown, usage, cursor, before });
    } catch (error) {
      setFailure(codeOf(error));
    }
  };

  const range = ({ week: name, start, end }: Week) => {
    const days = { dateStyle: "medium", timeZone: "UTC" } as const;
    const last = new Date(end.getTime() - 1);
    return t("week_option", { week: name, days: format.dateTimeRange(start, last, days) });
  };
  const options = weeks.map((each) => ({ value: each.week, label: range(each) }));
  const pick = (name: string) => setWeek(weeks.find((each) => each.week === name));

  let shown: ReactNode;
  if (failure !== undefined) {
    shown = <ErrorState module="credits" code={failure} onRetry={open} />;
  } else if (loaded === undefined) {
    shown = (
      <div className="grid gap-4">
        <LoadingState />
        <div aria-hidden="true" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {Array.from({ length: LOADING_TILES }, (_, tile) => (
            <div key={tile} className={TILE}>
              <Skeleton lines={2} />
            </div>
          ))}
        </div>
      </div>
    );
  } else {
    const { usage, cursor, before } = loaded;
    const next = usage.nextCursor;
    const pager = {
      onPrevious: before.length > 0 ? () => turn(before.at(-1), before.slice(0, -1)) : undefined,
      onNext: next === null ? undefined : () => turn(next, [...before, cursor]),
    };
    shown = <WeekCosts costs={loaded.costs} usage={usage.items} pager={pager} />;
  }

  return (
    <div className="grid gap-8">
      {loaded ? (
        <Balance balance={loaded.balance} />
      ) : failure === undefined ? (
        <div aria-hidden="true" className={`${CARD} min-h-48 sm:p-6`}>
          <Skeleton lines={3} />
        </div>
      ) : null}
      <section aria-labelledby="credits-week" className="grid gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="credits-week" className="text-lg font-semibold tracking-tight text-ink">
            {t("week")}
          </h2>
          <div className="w-full sm:w-80 [&_.wt-field]:min-w-0">
            <Select
              label={t("week_picker")}
              value={week?.week}
              options={options}
              onChange={(event) => pick(event.target.value)}
            />
          </div>
        </div>
        {shown}
      </section>
    </div>
  );
}

/**
 * What the organization has left, large, and when its period ends; a bar of the period's grant,
 * spent then reserved, the rest the credits left, with its legend.
 */
function Balance({ balance }: { balance: BalanceResponse }) {
  const t = useTranslations("credits.screen");
  const format = useFormatter();
  const { available, granted, reserved, committed, periodEnd } = balance;
  const amount = (value: string) => format.number(Number(value), AMOUNT);
  const day = { dateStyle: "medium", timeZone: "UTC" } as const;
  const legend = [
    { label: t("status_committed"), value: committed, dot: "bg-accent" },
    { label: t("status_reserved"), value: reserved, dot: "bg-warm-dot" },
  ];
  return (
    <section aria-labelledby="credits-balance" className={`${CARD} grid gap-5 sm:p-6`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="credits-balance" className="font-semibold text-ink">
          {t("balance")}
        </h2>
        {periodEnd && (
          <p className="text-sm text-ink-muted">
            {t("period_end", { date: format.dateTime(new Date(periodEnd), day) })}
          </p>
        )}
      </div>
      <p className="text-ink-muted">
        {t.rich("available", {
          available: amount(available),
          amount: (chunks) => (
            <span className="text-4xl font-semibold tracking-tight text-ink tabular-nums">
              {chunks}
            </span>
          ),
        })}
      </p>
      <div className="grid gap-3">
        <Meter
          size="md"
          max={Number(granted)}
          segments={[
            { value: Number(committed), tone: "accent" },
            { value: Number(reserved), tone: "warm" },
          ]}
        />
        <ul className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-ink-muted">
          {legend.map(({ label, value, dot }) => (
            <li key={label} className="flex items-center gap-2">
              <span aria-hidden="true" className={`size-2 rounded-full ${dot}`} />
              {label}
              <span className="font-medium text-ink tabular-nums">{amount(value)}</span>
            </li>
          ))}
          <li className="sm:ms-auto">{t("granted", { granted: amount(granted) })}</li>
        </ul>
      </div>
    </section>
  );
}

/** The week's numbers, its two breakdowns and its usage page; the empty state when nothing moved. */
function WeekCosts(props: {
  costs: CostsResponse;
  usage: Usage[];
  pager: { onPrevious?: () => void; onNext?: () => void };
}) {
  const { costs, usage, pager } = props;
  const t = useTranslations("credits.screen");
  const format = useFormatter();
  const amount = (value: string) => format.number(Number(value), AMOUNT);
  const statuses: Record<Usage["status"], string> = {
    reserved: t("status_reserved"),
    committed: t("status_committed"),
    released: t("status_released"),
    expired: t("status_expired"),
  };
  const nothing = [costs.byAction, costs.byVendor, usage].every((rows) => rows.length === 0);
  if (nothing && costs.qualified === 0) return <EmptyState message={t("empty")} />;
  const per100 = costs.costPer100Qualified;
  const numbers = [
    { label: t("spent_credits"), value: amount(costs.credits) },
    { label: t("spent_money"), value: amount(costs.money) },
    { label: t("qualified"), value: format.number(costs.qualified) },
    {
      label: t("per_100"),
      value: per100
        ? t("per_100_value", { credits: amount(per100.credits), money: amount(per100.money) })
        : t("per_100_none"),
      sentence: true,
    },
  ];
  const when = { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" } as const;
  const code = (action: string) => (
    <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-ink">{action}</code>
  );
  /** An amount, then a bar of its share of the week's whole. */
  const share = (value: string, whole: string) => (
    <span className="flex items-center gap-3">
      <span className="min-w-12 text-ink">{amount(value)}</span>
      <span className="w-full max-w-40">
        <Meter value={Number(value)} max={Number(whole)} />
      </span>
    </span>
  );
  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {numbers.map(({ label, value, sentence }) => (
            <div key={label} className={TILE}>
              <dt className="text-xs font-medium text-ink-muted">{label}</dt>
              <dd
                className={
                  sentence
                    ? "text-pretty font-semibold text-ink"
                    : "text-2xl font-semibold tracking-tight text-ink tabular-nums"
                }
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="flex items-start gap-2 text-xs text-ink-muted">
          <Info aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          {t("money_note")}
        </p>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="grid min-w-0 gap-3">
          <h3 className="text-sm font-semibold text-ink">{t("by_action")}</h3>
          <DataTable
            caption={t("by_action")}
            columns={[
              { id: "action", header: t("action"), cell: (row) => code(row.action) },
              {
                id: "credits",
                header: t("credits"),
                cell: (row) => share(row.credits, costs.credits),
              },
            ]}
            rows={costs.byAction.map((row) => ({ ...row, id: row.action }))}
            empty={<EmptyState message={t("by_action_none")} />}
          />
        </div>
        <div className="grid min-w-0 gap-3">
          <h3 className="text-sm font-semibold text-ink">{t("by_vendor")}</h3>
          <DataTable
            caption={t("by_vendor")}
            columns={[
              {
                id: "vendor",
                header: t("vendor"),
                cell: (row) => <span className="whitespace-nowrap">{row.vendor}</span>,
              },
              { id: "money", header: t("money"), cell: (row) => share(row.money, costs.money) },
            ]}
            rows={costs.byVendor.map((row) => ({ ...row, id: row.vendor }))}
            empty={<EmptyState message={t("by_vendor_none")} />}
          />
        </div>
      </div>
      <div className="grid min-w-0 gap-3">
        <h3 className="text-sm font-semibold text-ink">{t("usage")}</h3>
        <DataTable
          caption={t("usage")}
          columns={[
            {
              id: "at",
              header: t("at"),
              cell: (row) => (
                <time dateTime={row.createdAt} className="whitespace-nowrap">
                  {format.dateTime(new Date(row.createdAt), when)}
                </time>
              ),
            },
            { id: "action", header: t("action"), cell: (row) => code(row.action) },
            {
              id: "credits",
              header: t("credits"),
              cell: (row) => <span className="text-ink">{amount(row.credits)}</span>,
            },
            {
              id: "status",
              header: t("status"),
              cell: (row) => <Badge tone={STATUS_TONE[row.status]}>{statuses[row.status]}</Badge>,
            },
          ]}
          rows={usage}
          empty={<EmptyState message={t("usage_none")} />}
          pager={pager}
        />
      </div>
    </div>
  );
}
