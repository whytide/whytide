import type { ReactNode } from "react";
import { useTranslations } from "../translations.tsx";
import { cx } from "./cx.ts";

type SaveBarProps = {
  /** The form has changes not saved yet: the bar stays in view and says so. */
  dirty: boolean;
  /** A line before the actions: what a save does, or when the record last changed. */
  note?: ReactNode;
  /** The actions: Save, a submit button of the form. */
  children: ReactNode;
};

/** A form's last row: its note and its Save, which stays at the bottom of the screen while there are changes. */
export function SaveBar({ dirty, note, children }: SaveBarProps) {
  const t = useTranslations("ui.form");
  return (
    <div
      className={cx(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-xl border px-4 py-3 transition-[border-color,box-shadow] duration-150",
        dirty
          ? "sticky bottom-4 z-10 border-accent/40 bg-raised shadow-lg"
          : "border-line bg-surface shadow-xs",
      )}
    >
      <div className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-x-3 gap-y-1 text-ink-muted">
        {dirty ? (
          <span className="inline-flex items-center gap-2 font-medium text-ink">
            <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
            {t("unsaved")}
          </span>
        ) : null}
        {note}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
