import { CircleAlert } from "lucide-react";
import { type ReactNode, useId } from "react";
import { cx } from "./cx.ts";

/** A field's words, each translated by the caller from its own message keys. */
export type FieldText = {
  label: string;
  /** A sentence under the field that helps fill it in. */
  hint?: string;
  /** What is wrong with the value, the API's machine code translated; it marks the field invalid. */
  error?: string;
};

/** The id of a field's control: the caller's, else React's; the ids of its parts derive from it. */
export function useFieldId(id: string | undefined): string {
  const own = useId();
  return id ?? own;
}

/** A control's ARIA: described by its hint, its error and `more`, invalid while it has an error. */
export function fieldAria(id: string, text: FieldText, ...more: string[]) {
  const ids = [text.hint && `${id}-hint`, text.error && `${id}-error`, ...more].filter(Boolean);
  return {
    "aria-describedby": ids.length > 0 ? ids.join(" ") : undefined,
    "aria-invalid": text.error ? true : undefined,
  };
}

/** The frame the four fields share: the label, the control, then the hint and the error. */
export function Field(props: FieldText & { id: string; children: ReactNode }) {
  const { id, label, hint, error, children } = props;
  return (
    <div className="wt-field">
      <label id={`${id}-label`} htmlFor={id}>
        {label}
      </label>
      {children}
      <FieldNotes id={id} hint={hint} error={error} />
    </div>
  );
}

/** A field's hint and its error, with the ids its control's `aria-describedby` names. */
export function FieldNotes(props: Omit<FieldText, "label"> & { id: string; indent?: boolean }) {
  const { id, hint, error, indent } = props;
  return (
    <>
      {hint ? (
        <p id={`${id}-hint`} className={cx("wt-field__hint", indent && "ps-6.5")}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={`${id}-error`}
          className={cx("wt-field__error flex items-start gap-1.5", indent && "ps-6.5")}
        >
          <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </>
  );
}
