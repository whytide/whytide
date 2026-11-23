// The agents, /w/{workspace}/agents (README "Screens"), a server component: the workspace's agents,
// its audiences and its members, read through the api as the visitor, then New agent and the list,
// client components, which name each agent's audience and owner from them. The limits are the list's
// answer, as the api is configured (README "Settings"). The first read of the audiences creates the
// default, as the api does.
import { PageHeader } from "@whytide/ui";
import { data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import { AUDIENCES_PATH, MEMBERS_PATH, PLAYBOOKS_PATH } from "../constants.ts";
import { AgentList } from "./agent-list.tsx";
import { NewAgent } from "./new-agent.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function Agents({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("playbooks.list");
  const api = await serverApi();
  const request = { params: { path: { workspaceId: workspace } } };
  const [{ playbooks, limits }, { audiences }, { members }] = await Promise.all([
    data(api.GET(PLAYBOOKS_PATH, request)),
    data(api.GET(AUDIENCES_PATH, request)),
    data(api.GET(MEMBERS_PATH, request)),
  ]);
  return (
    <>
      {/* The document's title too (axe's document-title): React hoists it into the head. */}
      <title>{t("title")}</title>
      <PageHeader
        title={t("title")}
        description={t("description", { max: limits.sources })}
        actions={
          <NewAgent
            workspace={workspace}
            playbooks={playbooks}
            limits={limits}
            audiences={audiences}
          />
        }
      />
      <AgentList
        workspace={workspace}
        playbooks={playbooks}
        limits={limits}
        audiences={audiences}
        members={members}
      />
    </>
  );
}
