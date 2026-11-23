// The Results page in the browser (page.tsx gives it the first read): when the numbers were read,
// in the reader's time zone, named; then a card per campaign, in the route's order, by name, titled
// with its name (the seeded campaign's words for its empty one), its status on a badge and, in the
// view of a holder of campaigns.manage, its owner's name. Each card holds a table of five rows, the
// people enrolled, sent to, who accepted, replied and replied with interest, by three columns,
// LinkedIn, Email and All, each number over its share of the stage above it in the same column
// that has a number, none when that one is zero: email has no acceptance and All no send, a dash
// said as "not counted". The states: empty, no campaign of the reader's; a failed read in words, its
// module's (src/api/errors.ts errorOwner), with Try again, which reads again, the loading state
// while it does.
"use client";

import { Card, type Column, DataTable, EmptyState, ErrorState, LoadingState } from "@whytide/ui";
import { ApiError, browserApi, data, errorOwner } from "@whytide/web/api/browser";
import { useFormatter, useMessages, useTranslations } from "next-intl";
import { type ReactNode, useId, useState, useSyncExternalStore } from "react";
import type { FunnelResponse } from "../../schemas/funnel.ts";
import { StatusBadge, useCampaignText } from "../common.tsx";
import { AS_OF_FORMAT, FUNNEL_PATH } from "./constants.ts";

type Funnel = FunnelResponse["campaigns"][number];
type Stage = "enrolled" | "sent" | "accepted" | "replied" | "positive";
type Channel = "linkedin" | "email" | "all";
/** A stage's number on each channel; null where the route counts none. */
type Numbers = Record<Stage, number | null>;
type Row = { id: Stage; label: string } & Record<Channel, Cell>;
/** A number and its share of the stage above with a number, none when there is no such share. */
type Cell = { value: number | null; share?: number };
/** The first read's answer, or the digest of its refusal (`api:<code>`, src/api/errors.ts). */
type Props = { workspace: string } & ({ first: FunnelResponse } | { failed: string });

const STAGES: readonly Stage[] = ["enrolled", "sent", "accepted", "replied", "positive"];
const CHANNELS: readonly Channel[] = ["linkedin", "email", "all"];

const digestOf = (error: unknown) =>
  error instanceof ApiError ? error.digest : new ApiError(500, undefined).digest;

/** Each channel's stages: the people enrolled on every one, All's replies the totals. */
function numbersOf({ enrolled, linkedin, email, total }: Funnel): Record<Channel, Numbers> {
  return {
    linkedin: { enrolled, ...linkedin },
    email: { enrolled, ...email },
    all: { enrolled, sent: null, accepted: null, ...total },
  };
}

/** The stage's cell on the channel, its share of the nearest stage above it with a number. */
function cellOf(numbers: Numbers, index: number): Cell {
  const value = numbers[STAGES[index] ?? "enrolled"];
  const above = STAGES.slice(0, index)
    .map((stage) => numbers[stage])
    .findLast((n) => n !== null);
  if (value === null || above === undefined || above === null || above === 0) return { value };
  return { value, share: value / above };
}

const noChange = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function Results(props: Props) {
  const { workspace } = props;
  const t = useTranslations("campaigns.results");
  const format = useFormatter();
  const messages = useMessages();
  const text = useCampaignText();
  const id = useId();
  // The reader's zone, the browser's; before hydration, next-intl's, which the server rendered in.
  const zone = useSyncExternalStore(noChange, browserZone, () => undefined);
  const [funnel, setFunnel] = useState("first" in props ? props.first : undefined);
  const [failed, setFailed] = useState("failed" in props ? props.failed : undefined);
  const [reading, setReading] = useState(false);

  /** Try again: the route read once more, from the browser. */
  async function read() {
    setReading(true);
    try {
      const params = { path: { workspaceId: workspace } };
      setFunnel(await data(browserApi().GET(FUNNEL_PATH, { params })));
      setFailed(undefined);
    } catch (error) {
      setFailed(digestOf(error));
    } finally {
      setReading(false);
    }
  }

  if (reading) return <LoadingState />;
  if (failed !== undefined || funnel === undefined) {
    const owner = errorOwner({ digest: failed }, messages);
    return (
      <section aria-labelledby={`${id}-error`} className="grid max-w-3xl gap-3">
        <h2 id={`${id}-error`} className="font-semibold text-ink">
          {t("error")}
        </h2>
        <ErrorState module={owner.module} code={owner.code} onRetry={() => void read()} />
      </section>
    );
  }
  if (funnel.campaigns.length === 0) return <EmptyState message={t("empty")} />;

  const labels: Record<Stage, string> = {
    enrolled: t("rows.enrolled"),
    sent: t("rows.sent"),
    accepted: t("rows.accepted"),
    replied: t("rows.replied"),
    positive: t("rows.positive"),
  };
  const rowsOf = (campaign: Funnel): Row[] => {
    const numbers = numbersOf(campaign);
    return STAGES.map((stage, index) => ({
      ...{ id: stage, label: labels[stage] },
      ...{ linkedin: cellOf(numbers.linkedin, index), email: cellOf(numbers.email, index) },
      all: cellOf(numbers.all, index),
    }));
  };
  const shown = ({ value, share }: Cell): ReactNode =>
    value === null ? (
      <span className="grid">
        <span aria-hidden="true">{t("dash")}</span>
        <span className="sr-only">{t("not_counted")}</span>
      </span>
    ) : (
      <span className="grid">
        <span className="text-ink">{format.number(value)}</span>
        {share === undefined ? null : <span className="text-xs">{t("share", { share })}</span>}
      </span>
    );
  const headers: Record<Channel, string> = {
    linkedin: t("columns.linkedin"),
    email: t("columns.email"),
    all: t("columns.all"),
  };
  const columns: Column<Row>[] = [
    { id: "stage", header: t("columns.stage"), cell: ({ label }) => label },
    ...CHANNELS.map((channel) => ({
      id: channel,
      header: headers[channel],
      cell: (row: Row) => shown(row[channel]),
    })),
  ];
  const at = format.dateTime(new Date(funnel.asOf), { ...AS_OF_FORMAT, timeZone: zone });
  const owner = ({ ownerName }: Funnel) =>
    ownerName === undefined
      ? undefined
      : ownerName === null
        ? t("owner_unknown")
        : t("owner", { name: ownerName });

  return (
    <div className="grid gap-4">
      <p className="text-ink-muted">
        {t.rich("as_of", {
          at,
          time: (chunks) => <time dateTime={funnel.asOf}>{chunks}</time>,
        })}
      </p>
      {funnel.campaigns.map((campaign) => {
        const name = text.name(campaign.name);
        return (
          <Card
            key={campaign.campaignId}
            title={name}
            description={owner(campaign)}
            actions={<StatusBadge status={campaign.status} />}
          >
            <DataTable
              caption={t("caption", { campaign: name })}
              columns={columns}
              rows={rowsOf(campaign)}
            />
          </Card>
        );
      })}
    </div>
  );
}
