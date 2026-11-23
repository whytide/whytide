// The slots of the campaign's page (README.md "Screens"; gamma-p4-070): `disclosure`, where
// messaging's panel shows a channel's AI disclosure line under "Review first touches" in the
// approval mode's card, a `panels` entry of messaging's ui/nav.ts,
// `{ page: "campaigns.campaign", slot: "disclosure", screen: "disclosure" }`
// (core/apps/web/docs/screens.md). The web's route generator refuses a slot that is not listed here.
import type { DISCLOSURE_CHANNELS } from "../constants.ts";

export const slots = ["disclosure"] as const;
export type CampaignSlot = (typeof slots)[number];
/** What the page gives each panel: the channel whose line it shows. */
export type PanelProps = { readonly channel: (typeof DISCLOSURE_CHANNELS)[number] };
