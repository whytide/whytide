import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { Field, type FieldText, fieldAria, useFieldId } from "./field.tsx";

/** A choice: the value posted or kept, and its label, translated by the caller. */
export type SelectOption = { value: string; label: string };

export type SelectProps = FieldText &
  Omit<
    ComponentProps<"select">,
    "className" | "children" | "multiple" | "aria-describedby" | "aria-invalid"
  > & { options: SelectOption[] };

/** One value from a short list: a native `<select>`. Several values from a list: `ChipInput`. */
export function Select(props: SelectProps) {
  const { label, hint, error, id: given, options, ...rest } = props;
  const id = useFieldId(given);
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <div className="relative">
        <select
          {...rest}
          id={id}
          className="wt-field__control cursor-pointer appearance-none pe-9"
          {...fieldAria(id, { label, hint, error })}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
        />
      </div>
    </Field>
  );
}
