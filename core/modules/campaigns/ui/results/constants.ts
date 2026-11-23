// The Results page's values (README.md "Screens"), beside page.tsx and results.tsx, which read them.

/** campaigns' funnel route (README.md "Routes"). */
export const FUNNEL_PATH = "/v1/workspaces/{workspaceId}/campaigns/funnel";

/** The loading state's shimmering rows: a campaign's five stages. */
export const LOADING_ROWS = 5;

/** When the numbers were read, in the reader's time zone, named so that the reader knows which. */
export const AS_OF_FORMAT = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
} as const;
