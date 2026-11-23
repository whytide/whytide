// The Health page's values (README.md "Screens"), beside page.tsx, senders.tsx and sender-card.tsx,
// which read them.

/** linkedin's routes the senders' section composes (linkedin's README "API"). */
export const ACCOUNTS_PATH = "/v1/workspaces/{workspaceId}/linkedin/accounts";
export const ACCOUNT_HEALTH_PATH = "/v1/workspaces/{workspaceId}/linkedin/accounts/{id}/health";

/** The health events a card shows, newest first, of the ten the route answers. */
export const EVENTS_SHOWN = 5;

/** The loading state's shimmering lines: a section's, then a card's. */
export const SECTION_LOADING_LINES = 4;
export const CARD_LOADING_LINES = 3;

/** A time on a card, in the account's time zone, named so that the reader knows which. */
export const TIME_FORMAT = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
} as const;

/** The tone of each health state's badge (the kit's BadgeTone), as linkedin's health card has it. */
export const STATE_TONES = {
  healthy: "success",
  at_risk: "warning",
  restricted: "danger",
  checkpoint: "danger",
  disconnected: "neutral",
} as const;
