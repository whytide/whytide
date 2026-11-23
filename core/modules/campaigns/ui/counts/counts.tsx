// The counts in the browser (page.tsx gives it the first read): a card per sender account, in the
// route's order, by label, titled with the account's label and naming its time zone, holding a table
// of four rows, the connection requests sent, the messages sent, the invitations accepted and the
// people who replied, by three columns, today, the last 7 days and since the start, their headers
// short so that the table fits a phone's width, each number formatted for the reader's locale. An
// account linkedin no longer holds is titled as removed, its days UTC's. A line above them says
// whose accounts they are (gamma-p6-070): the member's own, or every member's for an Owner. The
// states: empty, nothing sent yet; a failed read in words, its module's (src/api/errors.ts
// errorOwner), with Try again, which reads again, the loading state while it does.
"use client";

import { Card, type Column, DataTable, EmptyState, ErrorState, LoadingState } from "@whytide/ui";
import { ApiError, browserApi, data, errorOwner } from "@whytide/web/api/browser";
import { useFormatter, useMessages, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { COUNTS_FALLBACK_ZONE } from "../../domain/constants.ts";
import type { CountsResponse } from "../../schemas/counts.ts";

type Sender = CountsResponse["senders"][number];
type Measure = keyof Sender["today"];
/** A row of a sender's table: a measure in words, and its number in each period. */
type Row = { id: Measure; label: string; today: number; last7Days: number; sinceStart: number };
/** The first read's answer, or the digest of its refusal (`api:<code>`, src/api/errors.ts). */
type Props = { workspace: string } & ({ first: CountsResponse } | { failed: string });

const digestOf = (error: unknown) =>
  error instanceof ApiError ? error.digest : new ApiError(500, undefined).digest;

export function Counts(props: Props) {
  const { workspace } = props;
  const t = useTranslations("campaigns.counts");
  const format = useFormatter();
  const messages = useMessages();
  const id = useId();
  const [counts, setCounts] = useState("first" in props ? props.first : undefined);
  const [failed, setFailed] = useState("failed" in props ? props.failed : undefined);
  const [reading, setReading] = useState(false);

  /** Try again: the route read once more, from the browser. */
  async function read() {
    setReading(true);
    try {
      const params = { path: { workspaceId: workspace } };
      const path = "/v1/workspaces/{workspaceId}/campaigns/counts";
      setCounts(await data(browserApi().GET(path, { params })));
      setFailed(undefined);
    } catch (error) {
      setFailed(digestOf(error));
    } finally {
      setReading(false);
    }
  }

  if (reading) return <LoadingState />;
  if (failed !== undefined || counts === undefined) {
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
  const scope = (
    <p className="text-sm text-ink-muted">
      {counts.scope === "all" ? t("scope_all") : t("scope_own")}
    </p>
  );
  if (counts.senders.length === 0) {
    return (
      <div className="grid gap-4">
        {scope}
        <EmptyState message={t("empty")} />
      </div>
    );
  }

  const measures: { id: Measure; label: string }[] = [
    { id: "invitesSent", label: t("rows.invites_sent") },
    { id: "messagesSent", label: t("rows.messages_sent") },
    { id: "accepted", label: t("rows.accepted") },
    { id: "replied", label: t("rows.replied") },
  ];
  const rowsOf = (sender: Sender): Row[] =>
    measures.map(({ id: measure, label }) => ({
      ...{ id: measure, label, today: sender.today[measure] },
      ...{ last7Days: sender.last7Days[measure], sinceStart: sender.sinceStart[measure] },
    }));
  const columns: Column<Row>[] = [
    { id: "measure", header: t("columns.measure"), cell: ({ label }) => label },
    { id: "today", header: t("columns.today"), cell: ({ today }) => format.number(today) },
    {
      id: "last_7_days",
      header: t("columns.last_7_days"),
      cell: ({ last7Days }) => format.number(last7Days),
    },
    {
      id: "since_start",
      header: t("columns.since_start"),
      cell: ({ sinceStart }) => format.number(sinceStart),
    },
  ];

  return (
    <div className="grid gap-4">
      {scope}
      {counts.senders.map((sender) => {
        const account = sender.label ?? t("account_removed");
        const zone = sender.timeZone ?? COUNTS_FALLBACK_ZONE;
        return (
          <Card key={sender.senderAccountId} title={account} description={t("zone", { zone })}>
            <DataTable
              caption={t("caption", { account })}
              columns={columns}
              rows={rowsOf(sender)}
            />
          </Card>
        );
      })}
    </div>
  );
}
