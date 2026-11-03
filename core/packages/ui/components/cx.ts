/** The class names given, those that are not false or empty, joined: `cx("flex", open && "ring-2")`. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
