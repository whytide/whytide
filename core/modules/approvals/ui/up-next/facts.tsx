// "Show facts" under a row (item.tsx): the facts its draft uses, by the draft's factIds, from
// messaging's dossier of the lead, read when the owner first opens them (GET
// …/messaging/leads/{personId}/dossier). It is today's dossier, and says so: a fact that changed
// since the draft was written shows as it reads now, and one gone is left out (README.md "Screen").
// Each fact's value, a date in words, with its source worded from its reference's table and column.
// A read the api refuses shows its code in words, with Try again.
"use client";

import { Button, ErrorState } from "@whytide/ui";
import { ChevronDown, ChevronUp } from "@whytide/ui/icons";
import { ApiError, browserApi, data, errorOwner } from "@whytide/web/api/browser";
import { useFormatter, useMessages, useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { FACT_DATE_FORMAT } from "./constants.ts";
import { useUpNextWords } from "./words.ts";

type Props = {
  workspace: string;
  personId: string;
  factIds: readonly string[];
  /** Under a row in a sender's section (queue.tsx): its title goes one level down. */
  nested?: boolean;
};

const readDossier = (workspace: string, personId: string) =>
  browserApi().GET("/v1/workspaces/{workspaceId}/messaging/leads/{personId}/dossier", {
    params: { path: { workspaceId: workspace, personId } },
  });
type Fact = NonNullable<Awaited<ReturnType<typeof readDossier>>["data"]>["facts"][number];

export function Facts({ workspace, personId, factIds, nested = false }: Props) {
  const t = useTranslations("approvals.up_next");
  const words = useUpNextWords();
  const messages = useMessages();
  const format = useFormatter();
  const id = useId();
  const Title = nested ? "h5" : "h4";
  const [open, setOpen] = useState(false);
  const [facts, setFacts] = useState<Fact[]>();
  const [failure, setFailure] = useState<ApiError>();
  const reading = useRef(false);

  /** The dossier read once; the facts the draft names, in its order. */
  async function read() {
    if (reading.current) return;
    reading.current = true;
    setFailure(undefined);
    try {
      const dossier = await data(readDossier(workspace, personId));
      setFacts(factIds.flatMap((factId) => dossier.facts.filter((fact) => fact.id === factId)));
    } catch (error) {
      setFailure(error instanceof ApiError ? error : new ApiError(500, undefined));
    } finally {
      reading.current = false;
    }
  }

  const toggle = () => {
    setOpen(!open);
    if (!open && facts === undefined) void read();
  };
  const owner = failure && errorOwner(failure, messages);
  const Chevron = open ? ChevronUp : ChevronDown;

  return (
    <div className="grid justify-items-start gap-2">
      <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={id} onClick={toggle}>
        <Chevron aria-hidden="true" />
        {open ? t("facts.hide") : t("facts.show")}
      </Button>
      {open && (
        <section id={id} aria-labelledby={`${id}-title`} className="grid w-full gap-2">
          <Title id={`${id}-title`} className="text-sm font-semibold text-ink">
            {t("facts.title")}
          </Title>
          {owner ? (
            <ErrorState module={owner.module} code={owner.code} onRetry={() => void read()} />
          ) : facts === undefined ? (
            <p role="status" className="wt-loading-state text-sm">
              <span className="wt-spinner" aria-hidden="true" />
              {t("facts.loading")}
            </p>
          ) : facts.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("facts.none")}</p>
          ) : (
            <ul className="grid gap-2">
              {facts.map(({ id: factId, kind, value, sourceRef }) => (
                <li key={factId} className="grid gap-0.5 rounded-lg bg-muted px-3 py-2">
                  <q className="font-medium wrap-break-word text-ink">
                    {kind === "date" ? format.dateTime(new Date(value), FACT_DATE_FORMAT) : value}
                  </q>{" "}
                  <span className="text-xs text-ink-muted">{words.source(sourceRef)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
