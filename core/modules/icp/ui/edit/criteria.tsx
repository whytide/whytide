// The criteria card of the ICP screen: one row per criterion, its name, its weight with a bar of its
// share, whether it is a must and whether it counts; then the sum of the weights with its bar, in the
// danger colour while it is not 100, and the api's error about them. Disabled, every row is read-only.
"use client";

import { Checkbox, Meter, TextField } from "@whytide/ui";
import { CircleAlert, CircleCheck } from "@whytide/ui/icons";
import { useTranslations } from "next-intl";
import type { Criterion, CriterionKey } from "../../domain/lists.ts";
import { criterionLabels } from "../labels.ts";

type Props = {
  criteria: Criterion[];
  error?: string;
  disabled?: boolean;
  onChange: (criteria: Criterion[]) => void;
};

export function CriteriaTable({ criteria, error, disabled, onChange }: Props) {
  const t = useTranslations("icp.screen");
  const names = criterionLabels(useTranslations());
  const sum = criteria.reduce((total, row) => total + row.weight, 0);
  const change = (key: CriterionKey, update: Partial<Criterion>) =>
    onChange(criteria.map((row) => (row.key === key ? { ...row, ...update } : row)));
  return (
    <section
      aria-labelledby="icp-criteria-title"
      className="grid gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs"
    >
      <header className="grid gap-1">
        <h2 id="icp-criteria-title" className="font-semibold text-ink">
          {t("criteria")}
        </h2>
        <p className="text-pretty text-ink-muted">{t("criteria_hint")}</p>
      </header>
      <div>
        {criteria.map((row) => (
          <fieldset
            key={row.key}
            disabled={disabled}
            className="grid grid-cols-[6rem_minmax(0,1fr)] items-end gap-x-6 gap-y-3 border-t border-line py-4 first:border-t-0 first:pt-0 sm:grid-cols-[minmax(0,12rem)_6rem_minmax(0,1fr)] lg:grid-cols-[14rem_6rem_minmax(0,1fr)_auto_auto] lg:[&:not(:first-child)_.wt-field>label]:sr-only [&_.wt-field]:min-w-0"
          >
            {/* Floated, so that the legend is a cell of the row's grid; its weight's field, narrow. In
                columns, from lg, the first row's Weight heads them all: the others' are for a screen
                reader only. */}
            <legend className="float-start col-span-full font-medium text-ink sm:col-span-1 sm:pb-2">
              {names[row.key]}
            </legend>
            <TextField
              label={t("weight")}
              inputMode="numeric"
              value={String(row.weight)}
              onChange={(event) => change(row.key, { weight: weightOf(event.target.value) })}
            />
            <span className="pb-4">
              <Meter value={row.weight} tone={row.enabled ? "accent" : "muted"} />
            </span>
            <span className="col-span-full flex flex-wrap gap-x-6 gap-y-2 lg:col-span-2 lg:pb-2">
              <Checkbox
                label={t("must")}
                checked={row.isMust}
                onChange={(event) => change(row.key, { isMust: event.target.checked })}
              />
              <Checkbox
                label={t("enabled")}
                checked={row.enabled}
                onChange={(event) => change(row.key, { enabled: event.target.checked })}
              />
            </span>
          </fieldset>
        ))}
      </div>
      <div className="grid gap-2 border-t border-line pt-4">
        <p
          role="status"
          className={`flex items-center gap-2 font-medium ${sum === 100 ? "text-success-ink" : "text-danger-ink"}`}
        >
          {sum === 100 ? (
            <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
          ) : (
            <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
          )}
          {t("sum", { sum })}
        </p>
        <Meter value={sum} tone={sum === 100 ? "accent" : "danger"} size="md" />
        {error ? (
          <p role="alert" className="wt-field__error">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** The digits typed, as a whole number from 0 to 100, the range the api takes. */
function weightOf(text: string): number {
  return Math.min(100, Number(text.replace(/\D/g, "") || 0));
}
