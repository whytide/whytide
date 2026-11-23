import { type KeyboardEvent, useState } from "react";
import { useTranslations } from "../translations.tsx";
import { NUMBER_FIELD_PAGE_STEPS, NUMBER_FIELD_STEP, WHOLE_NUMBER } from "./constants.ts";
import { Field, type FieldText, fieldAria, useFieldId } from "./field.tsx";

export type NumberFieldProps = FieldText & {
  id?: string;
  /** The whole number shown, or null for none: the module holds it. */
  value: number | null;
  /**
   * A whole number within `min` and `max`, from a key, or from the typed text once the field loses
   * the focus (or on Enter); null for typed text that is no such number, so that the module shows
   * its own error.
   */
  onChange: (value: number | null) => void;
  min: number;
  max: number;
  /** What Arrow Up and Arrow Down add or take away (1 unless given); Page Up and Down, ten of it. */
  step?: number;
  /** A word the module translated, shown after the box and spoken with the value ("business days"). */
  unit?: string;
};

/**
 * A whole number between `min` and `max`: a text box with the spin button role, so that the arrows,
 * Page Up and Page Down, Home and End change it within its bounds. Typed text stays as typed until
 * the field loses the focus; then the module hears of it.
 */
export function NumberField(props: NumberFieldProps) {
  const { label, hint, error, value, onChange, min, max, unit } = props;
  const step = props.step ?? NUMBER_FIELD_STEP;
  const t = useTranslations("ui.field");
  const id = useFieldId(props.id);
  // The text typed since the last value; null while the box shows `value`. Text that is no whole
  // number within the bounds stays once the field loses the focus, beside the module's error.
  const [draft, setDraft] = useState<string | null>(null);
  // A new value from the module replaces text left over (React's "adjusting state on a prop change").
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value !== null) setDraft(null);
  }

  const commit = () => {
    if (draft === null) return;
    const typed = whole(draft);
    const next = typed !== null && typed >= min && typed <= max ? typed : null;
    if (next !== null) setDraft(null);
    onChange(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter commits the typed text, as leaving the field does, and lets a form submit with it.
    if (event.key === "Enter") {
      commit();
      return;
    }
    // A key steps from the typed text when it is a whole number, else from the value; from none,
    // it starts at `min`.
    const from = (draft === null ? null : whole(draft)) ?? value;
    const by = (steps: number) => (from === null ? min : from + steps * step);
    const page = NUMBER_FIELD_PAGE_STEPS;
    const targets: Record<string, number> = {
      ArrowUp: by(1),
      ArrowDown: by(-1),
      PageUp: by(page),
      PageDown: by(-page),
      Home: min,
      End: max,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = Math.min(max, Math.max(min, target));
    setDraft(null);
    if (next !== value) onChange(next);
  };

  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          role="spinbutton"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          className="wt-field__control w-28 tabular-nums"
          value={draft ?? (value === null ? "" : String(value))}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value ?? undefined}
          aria-valuetext={
            unit !== undefined && value !== null ? t("number_unit", { value, unit }) : undefined
          }
          {...fieldAria(id, { label, hint, error })}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
        />
        {unit === undefined ? null : <span className="text-sm text-ink-muted">{unit}</span>}
      </div>
    </Field>
  );
}

/** The text as a whole number, or null: digits with a sign before them at most, nothing else. */
function whole(text: string): number | null {
  const trimmed = text.trim();
  if (!WHOLE_NUMBER.test(trimmed)) return null;
  const number = Number(trimmed);
  return Number.isSafeInteger(number) ? number : null;
}
