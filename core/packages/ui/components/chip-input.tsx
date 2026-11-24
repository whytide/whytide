import { X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslations } from "../translations.tsx";
import { Field, type FieldText, fieldAria, useFieldId } from "./field.tsx";
import type { SelectOption } from "./select.tsx";

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
 * closed list, where the input is a combobox whose list of the options not chosen yet opens on a
 * focus, narrows to the labels holding the typed text, and stays open after a pick for the next.
 */
export function ChipInput(props: ChipInputProps) {
  const { label, hint, error, options, name, disabled } = props;
  const t = useTranslations("ui.field");
  const id = useFieldId(props.id);
  const input = useRef<HTMLInputElement>(null);
  const listbox = useRef<HTMLUListElement>(null);
  const [kept, setKept] = useState(props.defaultValue ?? []);
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  // The option the arrows or the typed text made active: none while the list is closed, none on a
  // focus and none after a pick, so that Enter adds only an option the person has reached.
  const [active, setActive] = useState<number>();
  const chips = props.value ?? kept;
  const matches = options ? match(options, text, chips) : [];
  const open = expanded && matches.length > 0;
  const current = open && active !== undefined ? Math.min(active, matches.length - 1) : undefined;
  const labelOf = (value: string) => options?.find((o) => o.value === value)?.label ?? value;

  // The list scrolls inside its height: the active option stays in view as the arrows move it.
  useEffect(() => {
    if (current === undefined) return;
    listbox.current?.children.item(current)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const change = (next: string[]) => {
    if (props.value === undefined) setKept(next);
    props.onChange?.(next);
  };
  const close = () => {
    setExpanded(false);
    setActive(undefined);
  };
  // The list stays open: the picked option leaves it, and the next pick can follow.
  const add = (value: string) => {
    const same = (chip: string) => chip.toLocaleLowerCase() === value.toLocaleLowerCase();
    if (!chips.some(same)) change([...chips, value]);
    setText("");
    setActive(undefined);
  };
  const remove = (value: string) => {
    change(chips.filter((chip) => chip !== value));
    input.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (options && step !== 0) {
      // The arrows open the list and move through it; from none, down starts first and up last.
      event.preventDefault();
      const count = matches.length;
      if (count === 0) return;
      const start = step > 0 ? 0 : count - 1;
      setActive(current === undefined ? start : (current + step + count) % count);
      setExpanded(true);
    } else if (event.key === "Escape" && open) {
      // Closes the list only, not a dialog around it.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter") {
      // Enter adds rather than submits; with no text and no active option, it submits.
      const option = current === undefined ? undefined : matches[current]?.value;
      const value = options ? option : text.trim();
      if (value || text.trim() !== "") event.preventDefault();
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
              className="inline-flex min-h-7 items-start gap-0.5 rounded-md bg-muted py-0.5 ps-2 pe-0.5 text-sm font-medium text-ink ring-1 ring-line ring-inset"
            >
              {/* A long value wraps and its chip grows, the remove button by its first line. It may
                  break anywhere, so that a long word (a link) never widens the field or the page. */}
              <span className="py-0.5 wrap-anywhere">{labelOf(chip)}</span>
              <button
                type="button"
                className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-ink-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
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
          placeholder={options ? t("placeholder_options") : t("placeholder_text")}
          role={options ? "combobox" : undefined}
          aria-expanded={options ? open : undefined}
          aria-controls={options ? list : undefined}
          aria-autocomplete={options ? "list" : undefined}
          aria-activedescendant={current === undefined ? undefined : optionId(current)}
          {...fieldAria(id, { label, hint, error })}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
            setExpanded(true);
          }}
          onKeyDown={onKeyDown}
          // A focus opens the list, by Tab or by a click; a click into the focused input reopens it.
          onFocus={() => setExpanded(true)}
          onClick={() => setExpanded(true)}
          onBlur={close}
        />
        {options ? (
          // A press on an option leaves the focus in the input, so the list stays open for the click.
          // The input drives the list, so a list that scrolls takes no Tab stop of its own (tabIndex).
          <ul
            ref={listbox}
            id={list}
            role="listbox"
            tabIndex={-1}
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
    .sort((a, b) => starts(a) - starts(b));
}
