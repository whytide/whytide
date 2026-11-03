import type { ComponentProps } from "react";

/**
 * An on or off that applies at once: a native checkbox with the switch role, so that Space flips it,
 * named by its caller (a wrapping label, or `aria-label`). The knob is the input's own ::before.
 */
export function Switch(props: Omit<ComponentProps<"input">, "className" | "type" | "role">) {
  return (
    <input
      {...props}
      type="checkbox"
      role="switch"
      className="relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-line-strong transition-colors duration-150 before:absolute before:start-0.5 before:top-0.5 before:size-4 before:rounded-full before:bg-white before:shadow-xs before:transition-transform before:duration-150 checked:bg-accent checked:before:translate-x-4 checked:before:bg-on-accent disabled:cursor-not-allowed disabled:opacity-50 rtl:checked:before:-translate-x-4"
    />
  );
}
