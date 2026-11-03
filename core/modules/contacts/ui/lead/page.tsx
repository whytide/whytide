// The lead page (README.md "Screens"), read as the member: contacts' lead with its person's business
// fields and their provenance, whose name titles the document; then, while the loading state shows,
// its neighbours in the list's view (the URL's query, from the list's row link, else the list's
// first view: qualified leads by fit), qualification's snapshot of the lead, none until it scores
// one, and linkedin's accounts, of which Approve needs the user's own connected one (approve.tsx).
// Another workspace's person, or one without a lead, is the page's not-found state, and nothing
// more is read. The title comes before the loading state, since React leaves a fallback's title out
// of the server's page. The generated route passes the panels other modules registered, by slot
// (slots.ts); they render here, on the server, and view.tsx places them, each slot with its own
// loading state and error boundary.
import { data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import { type ComponentType, type ReactNode, Suspense } from "react";
import { type ListQuery, listQueryString, readListQuery } from "../leads/query.ts";
import { type LeadSlot, type PanelProps, slots } from "./slots.ts";
import { LeadLoading, LeadNotFound } from "./states.tsx";
import { LeadView } from "./view.tsx";

type Panels = Partial<Record<LeadSlot, readonly ComponentType<PanelProps>[]>>;
type Props = {
  params: Promise<{ workspace: string; personId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  panels: Panels;
};
type Api = Awaited<ReturnType<typeof serverApi>>;
type Path = { workspaceId: string; personId: string };
type Answer<T> = NonNullable<Awaited<T> extends { data?: infer D } ? D : never>;

const readLead = (api: Api, path: Path) =>
  api.GET("/v1/workspaces/{workspaceId}/contacts/leads/{personId}", { params: { path } });
const readSnapshot = (api: Api, path: Path) =>
  api.GET("/v1/workspaces/{workspaceId}/qualification/leads/{personId}/snapshot", {
    params: { path },
  });
export type Lead = Answer<ReturnType<typeof readLead>>;
export type Snapshot = Answer<ReturnType<typeof readSnapshot>>;
export type Neighbours = { previous: string | null; next: string | null };

export default async function LeadPage({ params, searchParams, panels }: Props) {
  const { workspace, personId } = await params;
  const named = readListQuery(await searchParams);
  const { status = "qualified", tier, sort = "fit", review, outreach } = named;
  const view = { status, tier, sort, review, outreach };
  const api = await serverApi();
  const path = { workspaceId: workspace, personId };
  const read = await readLead(api, path);
  if (read.response.status === 404) {
    return <LeadNotFound workspace={workspace} query={listQueryString(view)} />;
  }
  const lead = await data(Promise.resolve(read));
  const t = await getTranslations("contacts.leads");
  const { firstName, lastName, linkedinUrl } = lead.person;
  const name = t("name", { first: firstName ?? "", last: lastName ?? "" }).trim() || linkedinUrl;
  const back = `/w/${workspace}/leads${listQueryString(view)}`;
  return (
    <>
      <title>{name}</title>
      <Suspense fallback={<LeadLoading lead={lead} name={name} back={back} />}>
        <LeadRest workspace={workspace} lead={lead} name={name} view={view} panels={panels} />
      </Suspense>
    </>
  );
}

/** The lead's snapshot, neighbours and the user's senders, read at once, and the slots' panels. */
async function LeadRest(props: {
  workspace: string;
  lead: Lead;
  name: string;
  view: ListQuery;
  panels: Panels;
}) {
  const { workspace, lead, name, view, panels } = props;
  const api = await serverApi();
  const path = { workspaceId: workspace, personId: lead.personId };
  const [snapshot, neighbours, senders] = await Promise.all([
    readSnapshot(api, path),
    api.GET("/v1/workspaces/{workspaceId}/contacts/leads/{personId}/neighbours", {
      params: { path, query: view },
    }),
    data(
      api.GET("/v1/workspaces/{workspaceId}/linkedin/accounts", {
        params: { path: { workspaceId: workspace } },
      }),
    ),
  ]);
  // "No account": none of the user's own is connected (linkedin's GET …/accounts, `mine`).
  const hasSender = senders.accounts.some(({ mine, status }) => mine && status === "connected");
  const placed = slots.flatMap((slot): [LeadSlot, ReactNode][] => {
    const own = panels[slot] ?? [];
    // A slot's panels never move: their place is their key.
    const rendered = own.map((Panel, index) => (
      <Panel key={index} workspace={workspace} personId={lead.personId} />
    ));
    return own.length === 0 ? [] : [[slot, rendered]];
  });
  return (
    <LeadView
      workspace={workspace}
      lead={lead}
      name={name}
      snapshot={snapshot.response.status === 404 ? null : await data(Promise.resolve(snapshot))}
      neighbours={await data(Promise.resolve(neighbours))}
      query={listQueryString(view)}
      slots={Object.fromEntries(placed)}
      hasSender={hasSender}
    />
  );
}
