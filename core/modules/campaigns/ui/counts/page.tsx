// "Counts" (README.md "Screens"), /w/{ws}/counts, a server component: the <title> and the header,
// whose line says that the counts are per sender account, today and the last 7 days in the account's
// zone, and that a reply counts when it stopped a sequence; then the route's read, GET
// …/campaigns/counts as the member, while the loading state shows, a table's rows that shimmer.
// counts.tsx shows the answer in the browser: a card per sender account, the empty state, or a read
// the api refused, with Try again; any other fault is the route's. Read-only: nothing here acts on a
// sender, a step or a person. React puts the <title> in the document's head: the generated route
// re-exports the page alone, so a `metadata` export would not reach it.
import { LoadingState, PageHeader, Skeleton } from "@whytide/ui";
import { ApiError, data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { LOADING_ROWS } from "./constants.ts";
import { Counts } from "./counts.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function CountsPage({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("campaigns.counts");
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

/** The counts as the api answers them, or the digest of a read it refused. */
async function Read({ workspace }: { workspace: string }) {
  const params = { path: { workspaceId: workspace } };
  try {
    const api = await serverApi();
    const counts = await data(api.GET("/v1/workspaces/{workspaceId}/campaigns/counts", { params }));
    return <Counts workspace={workspace} first={counts} />;
  } catch (error) {
    if (error instanceof ApiError) return <Counts workspace={workspace} failed={error.digest} />;
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
