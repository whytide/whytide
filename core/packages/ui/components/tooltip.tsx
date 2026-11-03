import { type ReactNode, useEffect, useId, useState } from "react";
import { cx } from "./cx.ts";

/**
 * A short hint about its trigger, shown while the trigger is hovered or has the keyboard's focus.
 * Escape hides it wherever the focus is, a hint the pointer opened too (WCAG 1.4.13), until the
 * pointer or the focus leaves. The trigger takes the focus, and the hint describes it.
 */
export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const shown = (hovered || focused) && !dismissed;

  useEffect(() => {
    if (!shown) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDismissed(true);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [shown]);

  return (
    <span
      className="group/tooltip relative inline-flex"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setDismissed(false);
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setDismissed(false);
      }}
    >
      <span tabIndex={0} aria-describedby={id} className="inline-flex cursor-help rounded-full">
        {children}
      </span>
      {/* Right under the trigger, its padding a bridge, so that the pointer reaches the hint. */}
      <span
        id={id}
        role="tooltip"
        className={cx(
          "invisible absolute start-0 top-full z-20 w-max max-w-xs pt-1.5 opacity-0 transition-opacity duration-150 group-hover/tooltip:visible group-hover/tooltip:opacity-100 group-focus-within/tooltip:visible group-focus-within/tooltip:opacity-100",
          dismissed && "hidden",
        )}
      >
        <span className="block rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs leading-relaxed text-ink shadow-md">
          {content}
        </span>
      </span>
    </span>
  );
}
