import { ChevronDown, ChevronsUpDown } from "lucide-react";
import { type ComponentProps, type ReactNode, useId } from "react";
import { cx } from "./cx.ts";

/**
 * A button that opens a panel under it (`block`: the button as wide as its place, for a switcher).
 * The panel is a popover (`popover="auto"`): Escape and a click outside close it, Tab goes from the
 * button into it, and the focus comes back on close. A disclosure, not an ARIA menu, since the panel
 * holds any control (the theme's radios). CSS anchor positioning places it, flipped where the
 * viewport has no room.
 */
export function Menu(props: { trigger: ReactNode; block?: boolean; children: ReactNode }) {
  const { trigger, block, children } = props;
  const id = useId();
  const Chevron = block ? ChevronsUpDown : ChevronDown;
  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        className={cx(
          "inline-flex min-w-0 cursor-pointer items-center gap-2 rounded-lg text-sm font-medium text-ink-muted transition-colors hover:bg-hover hover:text-ink [&:has(+:popover-open)]:bg-hover [&:has(+:popover-open)]:text-ink",
          block ? "w-full p-1.5 text-start" : "h-9 ps-1 pe-2",
        )}
      >
        {trigger}
        <Chevron
          aria-hidden="true"
          className={cx(
            "size-3.5 shrink-0 transition-transform",
            block ? "ms-auto" : "[button:has(+:popover-open)_&]:rotate-180",
          )}
        />
      </button>
      <div
        id={id}
        popover="auto"
        className="inset-auto m-0 mt-2 max-h-[70dvh] w-72 overflow-y-auto rounded-xl border border-line bg-raised p-1.5 text-ink shadow-lg [position-area:block-end_span-inline-start] [position-try-fallbacks:flip-inline,flip-block,flip-block_flip-inline] open:animate-pop"
      >
        {children}
      </div>
    </>
  );
}

/** A row of a Menu's panel: a button with its icon first. */
export function MenuItem(props: Omit<ComponentProps<"button">, "className">) {
  return (
    <button
      type="button"
      {...props}
      className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-start text-sm text-ink transition-colors hover:bg-hover [&_svg]:size-4 [&_svg]:text-ink-muted"
    />
  );
}
