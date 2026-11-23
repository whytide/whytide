// An error as the commands print it and the 30-day rule's job logs it (README.md "The deletion
// script"): its code, or its class, never its message, which can quote a query's values.

/** The error's code, or its class: never its message. */
export function kindOf(error: unknown): string {
  const { code } = (error ?? {}) as { code?: unknown };
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "unknown";
}
