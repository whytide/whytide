import type { ComponentProps } from "react";
import { FieldNotes, type FieldText, fieldAria, useFieldId } from "./field.tsx";

export type CheckboxProps = FieldText &
  Omit<ComponentProps<"input">, "className" | "type" | "aria-describedby" | "aria-invalid">;

/** A yes or no: a native checkbox with its label after it, described by its hint and its error. */
export function Checkbox(props: CheckboxProps) {
  const { label, hint, error, id: given, ...rest } = props;
  const id = useFieldId(given);
  return (
    <div className="wt-field min-w-0 gap-1">
      <div className="flex items-center gap-2.5">
        <input
          {...rest}
          id={id}
          type="checkbox"
          className="size-4 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed"
          {...fieldAria(id, { label, hint, error })}
        />
        <label id={`${id}-label`} htmlFor={id} className="text-sm text-ink">
          {label}
        </label>
      </div>
      <FieldNotes id={id} hint={hint} error={error} indent />
    </div>
  );
}
