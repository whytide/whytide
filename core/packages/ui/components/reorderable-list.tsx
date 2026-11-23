import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "../translations.tsx";

export type ReorderableItem = {
  /** Stays with the item as it moves: the list follows the item by it. */
  key: string;
  /** The item's name, in words the module translated ("Step 2"): its buttons' names hold it. */
  name: string;
  /** What the item shows, rendered by the module. */
  content: ReactNode;
};

export type ReorderableListProps = {
  items: ReorderableItem[];
  /** Move up or Move down: the module moves the item at `from` to `to`, one place away. */
  onMove: (from: number, to: number) => void;
  /** With it, each item has a Remove button: the module removes the item at `index`. */
  onRemove?: (index: number) => void;
};

/** The item whose Remove the person pressed, and its place, until the module has removed it. */
type Removing = { key: string; index: number };

const BUTTON =
  "grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-ink-muted transition-colors hover:bg-hover hover:text-ink aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-ink-muted [&_svg]:size-4";

/**
 * An ordered list the person reorders with buttons, by keyboard and screen reader alike: each item
 * has Move up and Move down (`aria-disabled` at the ends, so the focus can stay on them) and, with
 * `onRemove`, Remove. After a move the focus stays on the moved item's button, and a polite live
 * region says where the item went. No drag and drop.
 */
export function ReorderableList({ items, onMove, onRemove }: ReorderableListProps) {
  const t = useTranslations("ui.list");
  const list = useRef<HTMLOListElement>(null);
  const removing = useRef<Removing | null>(null);
  const [said, setSaid] = useState("");

  // A moved item keeps its row, the same nodes by its key, and React keeps the focus on the button
  // pressed. A removed row takes that button along: once the module has removed the item, the focus
  // goes to the Remove now in its place (the one before, for the last), unless the module focused a
  // control itself.
  useLayoutEffect(() => {
    const removed = removing.current;
    if (!removed || items.some((item) => item.key === removed.key)) return;
    removing.current = null;
    const row = list.current?.children.item(Math.min(removed.index, items.length - 1));
    const button = row?.querySelector<HTMLElement>('[data-control="remove"]');
    const active = document.activeElement;
    if (button && (!active || active === document.body)) button.focus();
  }, [items]);

  const move = (index: number, to: number) => {
    const item = items[index];
    if (!item || to < 0 || to >= items.length) return;
    setSaid(t("moved", { item: item.name, position: to + 1, count: items.length }));
    onMove(index, to);
  };
  const remove = (index: number) => {
    const item = items[index];
    if (!item || !onRemove) return;
    removing.current = { key: item.key, index };
    onRemove(index);
  };

  return (
    <div className="wt-reorderable-list grid gap-2">
      <ol ref={list} className="grid gap-2">
        {items.map((item, index) => (
          <li
            key={item.key}
            className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 shadow-xs"
          >
            <div className="min-w-0 flex-1">{item.content}</div>
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                className={BUTTON}
                aria-label={t("move_up", { item: item.name })}
                aria-disabled={index === 0 || undefined}
                onClick={() => move(index, index - 1)}
              >
                <ArrowUp aria-hidden="true" />
              </button>
              <button
                type="button"
                className={BUTTON}
                aria-label={t("move_down", { item: item.name })}
                aria-disabled={index === items.length - 1 || undefined}
                onClick={() => move(index, index + 1)}
              >
                <ArrowDown aria-hidden="true" />
              </button>
              {onRemove ? (
                <button
                  type="button"
                  className={BUTTON}
                  data-control="remove"
                  aria-label={t("remove", { item: item.name })}
                  onClick={() => remove(index)}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <p role="status" className="sr-only">
        {said}
      </p>
    </div>
  );
}
