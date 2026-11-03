import { X } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { useTranslations } from "../translations.tsx";
import { Field, type FieldText, fieldAria, useFieldId } from "./field.tsx";
import type { SelectOption } from "./select.tsx";

/** The most options the list shows: more letters narrow it, so it never has to scroll. */
const SHOWN = 8;

export type ChipInputProps = FieldText & {
  id?: string;
  /** The values, when the caller keeps them; otherwise `defaultValue`, kept here. */
  value?: string[];
  defaultValue?: string[];
  onChange?: (value: string[]) => void;
  /** A closed list (countries, say): only its values are added, shown by label. Free text without. */
  options?: SelectOption[];
  /** Posts each value under this name with the form, as a multiple select does. */
  name?: string;
  disabled?: boolean;
};

/**
 * Values shown as chips, each with its remove button: job titles as free text, or countries from a
 * closed list, where the input is a combobox over the options whose label holds the typed text.
 */
export function ChipInput(props: ChipInputProps) {
  const { label, hint, error, options, name, disabled } = props;
  const t = useTranslations("ui.field");
  const id = useFieldId(props.id);
  const input = useRef<HTMLInputElement>(null);
  const [kept, setKept] = useState(props.defaultValue ?? []);
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(0);
  const chips = props.value ?? kept;
  const matches = options ? match(options, text, chips) : [];
  const open = expanded && matches.length > 0;
  const current = Math.min(active, matches.length - 1);
  const labelOf = (value: string) => options?.find((o) => o.value === value)?.label ?? value;

  const change = (next: string[]) => {
    if (props.value === undefined) setKept(next);
    props.onChange?.(next);
  };
  const add = (value: string) => {
    const same = (chip: string) => chip.toLocaleLowerCase() === value.toLocaleLowerCase();
    if (!chips.some(same)) change([...chips, value]);
    setText("");
    setExpanded(false);
  };
  const remove = (value: string) => {
    change(chips.filter((chip) => chip !== value));
    input.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (options && step !== 0) {
      event.preventDefault();
      setActive(open ? (current + step + matches.length) % matches.length : 0);
      setExpanded(true);
    } else if (event.key === "Escape" && open) {
      // Closes the list only, not a dialog around it.
      event.preventDefault();
      event.stopPropagation();
      setExpanded(false);
    } else if (event.key === "Enter" && (open || text.trim() !== "")) {
      // Enter adds rather than submits; on an empty input with the list closed, it submits.
      event.preventDefault();
      const value = options ? (open ? matches[current]?.value : undefined) : text.trim();
      if (value) add(value);
    }
  };

  const list = `${id}-options`;
  const optionId = (index: number) => `${id}-option-${index}`;
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      {chips.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-labelledby={`${id}-label`}>
          {chips.map((chip) => (
            <li
              key={chip}
              className="inline-flex h-7 items-center gap-0.5 rounded-md bg-muted ps-2 pe-0.5 text-sm font-medium text-ink ring-1 ring-line ring-inset"
            >
              {labelOf(chip)}
              <button
                type="button"
                className="grid size-6 cursor-pointer place-items-center rounded text-ink-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={t("remove", { item: labelOf(chip) })}
                disabled={disabled}
                onClick={() => remove(chip)}
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
              {name ? <input type="hidden" name={name} value={chip} disabled={disabled} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="relative">
        <input
          ref={input}
          id={id}
          className="wt-field__control"
          value={text}
          disabled={disabled}
          autoComplete="off"
          role={options ? "combobox" : undefined}
          aria-expanded={options ? open : undefined}
          aria-controls={options ? list : undefined}
          aria-autocomplete={options ? "list" : undefined}
          aria-activedescendant={open ? optionId(current) : undefined}
          {...fieldAria(id, { label, hint, error })}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
            setExpanded(true);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setExpanded(false)}
        />
        {options ? (
          // A press on an option leaves the focus in the input, so the list stays open for the click.
          <ul
            id={list}
            role="listbox"
            className="absolute inset-x-0 top-full z-20 mt-1 grid max-h-80 gap-px overflow-auto rounded-lg border border-line bg-raised p-1 shadow-lg"
            aria-labelledby={`${id}-label`}
            hidden={!open}
            onMouseDown={(event) => event.preventDefault()}
          >
            {open
              ? matches.map((choice, index) => (
                  <li
                    key={choice.value}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === current}
                    className="cursor-pointer rounded-md px-2.5 py-1.5 text-sm text-ink hover:bg-hover aria-selected:bg-accent-soft aria-selected:text-accent-ink"
                    onClick={() => add(choice.value)}
                  >
                    {choice.label}
                  </li>
                ))
              : null}
          </ul>
        ) : null}
      </div>
    </Field>
  );
}

/** The options not chosen yet whose label holds the text, those that start with it first. */
function match(options: SelectOption[], text: string, chosen: string[]): SelectOption[] {
  const query = text.trim().toLocaleLowerCase();
  const starts = (o: SelectOption) => (o.label.toLocaleLowerCase().startsWith(query) ? 0 : 1);
  return options
    .filter((o) => !chosen.includes(o.value) && o.label.toLocaleLowerCase().includes(query))
    .sort((a, b) => starts(a) - starts(b))
    .slice(0, SHOWN);
}
