"use client";
// The list of agents (README "Screens"): the kit's DataTable of the workspace's agents in the api's
// order, the live ones first, each with its audience, its owner, its status and its sources' count
// of the list's limits.sources, its name the link to its page; the module's empty state while there
// is none. An owner is named as the members screen names them; one removed since is a former member,
// and their agent paused because they left says so in its status.
import { type Column, DataTable, EmptyState } from "@whytide/ui";
import { useTranslations } from "next-intl";
import type { PlaybookListResponse } from "../../schemas/playbooks.ts";
import { type Audience, type Member, StatusBadge, useAudienceName } from "../common.tsx";
import { agentScreen } from "../constants.ts";

type ListedAgent = PlaybookListResponse["playbooks"][number];
type Props = {
  workspace: string;
  playbooks: ListedAgent[];
  /** The limits the api answers with the list. */
  limits: PlaybookListResponse["limits"];
  audiences: readonly Audience[];
  members: readonly Member[];
};

export function AgentList({ workspace, playbooks, limits, audiences, members }: Props) {
  const t = useTranslations("playbooks.list");
  const audienceName = useAudienceName(audiences);
  const ownerName = (userId: string) => {
    const owner = members.find((member) => member.userId === userId);
    return owner === undefined ? t("former_member") : (owner.displayName ?? owner.email);
  };
  const max = limits.sources;
  const columns: Column<ListedAgent>[] = [
    { id: "name", header: t("column_name"), cell: (agent) => agent.name },
    { id: "audience", header: t("column_audience"), cell: (agent) => audienceName(agent.icpId) },
    { id: "owner", header: t("column_owner"), cell: (agent) => ownerName(agent.ownerUserId) },
    {
      id: "status",
      header: t("column_status"),
      cell: (agent) => <StatusBadge status={agent.status} pausedReason={agent.pausedReason} />,
    },
    {
      id: "sources",
      header: t("column_sources"),
      cell: (agent) => t("source_count", { count: agent.sourceCount, max }),
    },
  ];
  return (
    <DataTable
      caption={t("caption")}
      columns={columns}
      rows={playbooks}
      rowHref={(agent) => agentScreen(workspace, agent.id)}
      empty={<EmptyState message={t("empty")} />}
    />
  );
}
