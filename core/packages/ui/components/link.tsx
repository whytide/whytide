import type { ComponentProps } from "react";

/** A native `<a>`, in the colour of action, with the focus ring of the tokens. */
export function Link(props: Omit<ComponentProps<"a">, "className">) {
  return <a {...props} className="wt-link" />;
}
