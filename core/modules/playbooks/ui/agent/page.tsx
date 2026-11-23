// The agent's page, /w/{workspace}/agents/{playbookId} (README "Screens"), a server component: the
// agent with its sources' ids, then the workspace's audiences and agents, with the limits the list
// answers, through the api as the visitor, which agent.tsx, a client component, shows and changes.
// An agent the workspace does not hold is the page's not-found state, and nothing more is read. The
// generated route passes the panels other modules registered, by slot (slots.ts): they render here,
// on the server, each slot behind an error boundary and in a Suspense of its own
// (slot-boundary.tsx), under the agent. Who is signed in (GET /v1/me) says whether the visitor may
// change the agent: its owner, or a holder of playbooks.manage (README "Decided here"); and whether
// they own it, who alone resumes it once paused because they left the workspace (gamma-p6-075).
import { ButtonLink, EmptyState, PageHeader } from "@whytide/ui";
import { ArrowLeft } from "@whytide/ui/icons";
import { data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import type { ComponentType } from "react";
import { PLAYBOOKS_MANAGE_ROLES } from "../../domain/constants.ts";
import { AUDIENCES_PATH, agentsScreen, PLAYBOOK_PATH, PLAYBOOKS_PATH } from "../constants.ts";
import { Agent } from "./agent.tsx";
import { SlotBoundary } from "./slot-boundary.tsx";
import { type AgentSlot, type PanelProps, slots } from "./slots.ts";

type Panels = Partial<Record<AgentSlot, readonly ComponentType<PanelProps>[]>>;
type Props = {
  params: Promise<{ workspace: string; playbookId: string }>;
  panels: Panels;
};

export default async function AgentPage({ params, panels }: Props) {
  const { workspace, playbookId } = await params;
  const api = await serverApi();
  const path = { workspaceId: workspace };
  const read = await api.GET(PLAYBOOK_PATH, { params: { path: { ...path, playbookId } } });
  if (read.response.status === 404) return <AgentNotFound workspace={workspace} />;
  const agent = await data(Promise.resolve(read));
  const [{ audiences }, { playbooks, limits }, me] = await Promise.all([
    data(api.GET(AUDIENCES_PATH, { params: { path } })),
    data(api.GET(PLAYBOOKS_PATH, { params: { path } })),
    data(api.GET("/v1/me")),
  ]);
  const role = me.memberships.find(
    ({ workspaceId, slug }) => workspaceId === workspace || slug === workspace,
  )?.role;
  const owned = agent.ownerUserId === me.user.id;
  const writable = PLAYBOOKS_MANAGE_ROLES.some((manager) => manager === role) || owned;
  const placed = slots.flatMap((slot) => {
    const own = panels[slot] ?? [];
    // A slot's panels never move: their place is their key.
    const rendered = own.map((Panel, index) => (
      <Panel key={index} workspace={workspace} playbookId={agent.id} />
    ));
    return own.length === 0 ? [] : [<SlotBoundary key={slot}>{rendered}</SlotBoundary>];
  });
  return (
    <Agent
      workspace={workspace}
      initial={agent}
      audiences={audiences}
      playbooks={playbooks}
      limits={limits}
      writable={writable}
      owned={owned}
    >
      {placed}
    </Agent>
  );
}

/** Another workspace's agent, or none: a heading, why, and the way back to the list. */
async function AgentNotFound({ workspace }: { workspace: string }) {
  const t = await getTranslations("playbooks");
  return (
    <>
      <title>{t("agent.not_found")}</title>
      <PageHeader title={t("agent.not_found")} />
      <EmptyState
        message={t("errors.playbook_not_found")}
        action={
          <div>
            <ButtonLink href={agentsScreen(workspace)}>
              <ArrowLeft aria-hidden="true" className="rtl:-scale-x-100" />
              {t("agent.back")}
            </ButtonLink>
          </div>
        }
      />
    </>
  );
}
