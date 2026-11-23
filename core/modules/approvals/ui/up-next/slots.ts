// The slots of "Up next" (README.md "Screen"; gamma-p4-090): `disclosure`, where messaging's panel
// shows a channel's AI disclosure line on a row the campaign's mode will approve, a `panels` entry
// of messaging's ui/nav.ts, `{ page: "approvals.up-next", slot: "disclosure", screen: "disclosure" }`
// (core/apps/web/docs/screens.md). The web's route generator refuses a slot that is not listed here.
export const slots = ["disclosure"] as const;
export type UpNextSlot = (typeof slots)[number];
/** What the page gives a panel: the channel whose line it shows, once per channel. */
export type PanelProps = { readonly channel: "linkedin_message" | "email" };
