import type { ComponentProps } from "react";
import { Field, type FieldText, fieldAria, useFieldId } from "./field.tsx";

export type TextFieldProps = FieldText &
  Omit<ComponentProps<"input">, "className" | "type" | "aria-describedby" | "aria-invalid"> & {
    type?: "text" | "email" | "url" | "search" | "tel" | "password";
  };

/** One line of text: a native `<input>`, labelled, described by its hint and its error. */
export function TextField(props: TextFieldProps) {
  const { label, hint, error, id: given, type = "text", ...rest } = props;
  const id = useFieldId(given);
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <input
        {...rest}
        id={id}
        type={type}
        className="wt-field__control"
        {...fieldAria(id, { label, hint, error })}
      />
    </Field>
  );
}
