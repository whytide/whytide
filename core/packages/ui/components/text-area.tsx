import { type ComponentProps, useState } from "react";
import { useTranslations } from "../translations.tsx";
import { Field, type FieldText, fieldAria, useFieldId } from "./field.tsx";

export type TextAreaProps = FieldText &
  Omit<
    ComponentProps<"textarea">,
    "className" | "children" | "value" | "defaultValue" | "aria-describedby" | "aria-invalid"
  > & { value?: string; defaultValue?: string };

/**
 * Several lines of text: a native `<textarea>`. With `maxLength`, a counter under it says how many
 * characters it holds of the most it takes, and the browser refuses one more, typed or pasted.
 */
export function TextArea(props: TextAreaProps) {
  const { label, hint, error, id: given, maxLength, onChange, ...rest } = props;
  const t = useTranslations("ui.field");
  const id = useFieldId(given);
  const [typed, setTyped] = useState(() => (rest.defaultValue ?? "").length);
  const length = rest.value?.length ?? typed;
  const counter = `${id}-counter`;
  const described = maxLength === undefined ? [] : [counter];
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <textarea
        {...rest}
        id={id}
        maxLength={maxLength}
        className="wt-field__control"
        {...fieldAria(id, { label, hint, error }, ...described)}
        onChange={(event) => {
          setTyped(event.target.value.length);
          onChange?.(event);
        }}
      />
      {maxLength === undefined ? null : (
        <p
          id={counter}
          className="wt-field__counter -mt-0.5 text-end text-xs text-ink-muted tabular-nums"
        >
          {t("counter", { count: length, max: maxLength })}
        </p>
      )}
    </Field>
  );
}
