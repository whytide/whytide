import type { ComponentProps } from "react";
import { cx } from "./cx.ts";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

export type ButtonProps = Omit<ComponentProps<"button">, "className"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Busy: the label stays, a spinner shows, a click does nothing, and the focus stays put. */
  loading?: boolean;
};

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent shadow-sm inset-shadow-[0_1px_0_rgb(255_255_255/0.14)] hover:bg-accent-hover",
  secondary:
    "border border-line bg-surface text-ink shadow-xs hover:border-line-strong/40 hover:bg-muted aria-pressed:border-accent/45 aria-pressed:bg-accent-soft aria-pressed:text-accent-ink",
  danger: "bg-danger text-white shadow-sm hover:bg-danger-hover",
  ghost: "text-ink-muted hover:bg-hover hover:text-ink",
};
const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-2.5 text-[0.8125rem]",
  md: "h-9 gap-2 px-3.5 text-sm",
};

/** A button's classes, for a link that looks like one (ButtonLink) and the table's pager. */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md") {
  return cx(
    "wt-button inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap rounded-lg font-medium transition duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 aria-busy:cursor-wait [&[aria-disabled]:not([aria-busy])]:cursor-not-allowed [&[aria-disabled]:not([aria-busy])]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
    VARIANTS[variant],
    SIZES[size],
  );
}

/** A native `<button>`, `type="button"` unless told otherwise, so Enter and Space work as they should. */
export function Button(props: ButtonProps) {
  const {
    variant = "secondary",
    size = "md",
    loading = false,
    type = "button",
    onClick,
    children,
    ...rest
  } = props;
  return (
    <button
      {...rest}
      type={type}
      className={buttonClass(variant, size)}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={loading ? (event) => event.preventDefault() : onClick}
    >
      {loading ? <span className="wt-spinner size-3.5" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/** A native `<a>` that looks like a button: an action that goes to another page. */
export function ButtonLink(
  props: Omit<ComponentProps<"a">, "className"> & { variant?: ButtonVariant; size?: ButtonSize },
) {
  const { variant = "secondary", size = "md", ...rest } = props;
  return <a {...rest} className={buttonClass(variant, size)} />;
}
