// A failed call to the api on the Company Knowledge screen: its code, which the kit's ErrorState puts
// in words, and the retry that sends the same request again, when a retry can help. No import of the
// web: the module's build compiles this file (tsconfig.json), and only the web compiles the screens.

export type Problem = { readonly code: string; readonly retry?: () => void };

/** The code of a failed call, an ApiError's; else internal_error (no answer: the network). */
export function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : "internal_error";
}
