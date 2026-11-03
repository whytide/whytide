// The draft panel in the lead page's draft slot (ui/nav.ts `panels`; README.md "The draft panel"):
// the person's drafts, newest first, read as the member when the page loads, while the slot shows
// its loading state; when the newest has a plan, also the dossier's facts, of which the browser
// shows the ones a plan cites, and which it reads again when a newer plan was written on another
// dossier. drafts.tsx, in the browser, does the rest. A read the api refuses is the panel's error
// state, with the code in words and a retry; any other error is the slot's. The panel reads and
// writes messaging's routes only: it never calls a model or another module.
import { ApiError, data, serverApi } from "@whytide/web/api/server";
import { Drafts, DraftsFailed } from "./drafts.tsx";

type Api = Awaited<ReturnType<typeof serverApi>>;
type Path = { workspaceId: string; personId: string };

const readDrafts = (api: Api, path: Path) =>
  api.GET("/v1/workspaces/{workspaceId}/messaging/leads/{personId}/drafts", { params: { path } });
const readDossier = (api: Api, path: Path) =>
  api.GET("/v1/workspaces/{workspaceId}/messaging/leads/{personId}/dossier", { params: { path } });
export type Draft = NonNullable<Awaited<ReturnType<typeof readDrafts>>["data"]>["drafts"][number];
export type Fact = NonNullable<Awaited<ReturnType<typeof readDossier>>["data"]>["facts"][number];
/** The dossier's facts as read, `hash` its hash then, for the drafts whose hash was `asked`. */
export type Cited = { readonly asked: string; readonly hash: string; readonly facts: Fact[] };

type Read = { drafts: Draft[]; cited?: Cited } | { failed: string };

/** The drafts and, for the newest's plan, the dossier's facts; the code of a read the api refused. */
async function read(api: Api, path: Path): Promise<Read> {
  try {
    const { drafts } = await data(readDrafts(api, path));
    const [newest] = drafts;
    if (!newest?.plan || !newest.dossierHash) return { drafts };
    const { dossierHash, facts } = await data(readDossier(api, path));
    return { drafts, cited: { asked: newest.dossierHash, hash: dossierHash, facts } };
  } catch (error) {
    if (error instanceof ApiError) return { failed: error.code };
    throw error;
  }
}

export default async function DraftPanel(props: { workspace: string; personId: string }) {
  const { workspace, personId } = props;
  const answer = await read(await serverApi(), { workspaceId: workspace, personId });
  if ("failed" in answer) return <DraftsFailed code={answer.failed} />;
  return (
    <Drafts workspace={workspace} personId={personId} first={answer.drafts} cited={answer.cited} />
  );
}
