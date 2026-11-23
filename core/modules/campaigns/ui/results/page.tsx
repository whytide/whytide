// "Results" (README.md "Screens"), /w/{ws}/results, a server component: the <title> and the header,
// whose line says what each stage counts and that each share is of the stage above; then the
// route's read, GET …/campaigns/funnel as the member, while the loading state shows, a table's rows
// that shimmer. results.tsx shows the answer in the browser: a card per campaign, the empty state,
// or a read the api refused, with Try again; any other fault is the route's. Read-only: nothing
// here acts on a campaign or a person. React puts the <title> in the document's head: the generated
// route re-exports the page alone, so a `metadata` export would not reach it.
import { LoadingState, PageHeader, Skeleton } from "@whytide/ui";
import { ApiError, data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { FUNNEL_PATH, LOADING_ROWS } from "./constants.ts";
import { Results } from "./results.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function ResultsPage({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("campaigns.results");
  return (
    <>
      <title>{t("title")}</title>
      <PageHeader title={t("title")} description={t("description")} />
      <Suspense fallback={<Loading />}>
        <Read workspace={workspace} />
      </Suspense>
    </>
  );
}

/** The funnel as the api answers it, or the digest of a read it refused. */
async function Read({ workspace }: { workspace: string }) {
  const params = { path: { workspaceId: workspace } };
  try {
    const api = await serverApi();
    const funnel = await data(api.GET(FUNNEL_PATH, { params }));
    return <Results workspace={workspace} first={funnel} />;
  } catch (error) {
    if (error instanceof ApiError) return <Results workspace={workspace} failed={error.digest} />;
    throw error;
  }
}

/** The wait announced, and a table's rows that shimmer. */
function Loading() {
  return (
    <section aria-busy="true" className="grid gap-3">
      <LoadingState />
      <Skeleton shape="table" lines={LOADING_ROWS} />
    </section>
  );
}
