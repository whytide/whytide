// What the agents' two screens share (README "Screens"): the fields they read of icp's audiences,
// tenancy's members and signals' sources, an agent that counts, its status in words, and an
// audience's name. One t() call per status, written out, so that the message check reads every key;
// an agent paused because its owner left the workspace says so (gamma-p6-075).
import { Badge } from "@whytide/ui";
import { useTranslations } from "next-intl";
import { LIVE_STATUSES, type PausedReason, type PlaybookStatus } from "../domain/constants.ts";
import { STATUS_TONES } from "./constants.ts";

/** An audience as icp's GET …/icp/audiences answers it: the default may have no name. */
export type Audience = { readonly id: string; readonly name: string; readonly isDefault: boolean };
/** A member as tenancy's GET …/tenancy/members answers one: an agent's owner. */
export type Member = {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
};

/** Active or paused: an agent that counts against the limit and holds its audience. */
export const isLive = (agent: { readonly status: PlaybookStatus }): boolean =>
  LIVE_STATUSES.some((status) => status === agent.status);

/** Paused because its owner left the workspace: only that owner, a member again, resumes it. */
export const isOwnerRemoved = (agent: {
  readonly status: PlaybookStatus;
  readonly pausedReason: PausedReason | null;
}): boolean => agent.status === "paused" && agent.pausedReason === "member_removed";

type BadgeProps = { status: PlaybookStatus; pausedReason: PausedReason | null };

export function StatusBadge({ status, pausedReason }: BadgeProps) {
  const t = useTranslations("playbooks.agent.status");
  const paused = isOwnerRemoved({ status, pausedReason }) ? t("paused_owner_removed") : t("paused");
  const words = { active: t("active"), paused, archived: t("archived") };
  return <Badge tone={STATUS_TONES[status]}>{words[status]}</Badge>;
}

/** An audience's name by its id: the default's own words while no one named it, as icp's screen. */
export function useAudienceName(audiences: readonly Audience[]): (icpId: string) => string {
  const t = useTranslations("playbooks.agent");
  return (icpId) => {
    const audience = audiences.find(({ id }) => id === icpId);
    if (audience === undefined) return t("unknown_audience");
    return audience.name || t("default_audience");
  };
}
