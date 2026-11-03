// "Inbox" (README.md "Screen"), a server component: the <title> and the header, which says that only
// the conversations the platform started appear and that the tester answers on LinkedIn; then the
// list's first read, GET …/inbox/threads as the member, while the loading state shows, rows that
// shimmer where the threads will come. threads.tsx holds the rest in the browser: the table, "Load
// more" and the reads after the first. A read the api refuses is the list's error state, with Try
// again; any other fault is the route's. React puts the <title> in the document's head: the generated
// route re-exports the page alone, so a `metadata` export would not reach it.
import { LoadingState, PageHeader, Skeleton } from "@whytide/ui";
import { ApiError, data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { LOADING_ROWS, PAGE_SIZE } from "./constants.ts";
import { Threads } from "./threads.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function Inbox({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("inbox.list");
  return (
    <>
      <title>{t("title")}</title>
      <PageHeader title={t("title")} description={t("description")} />
      <Suspense fallback={<Loading />}>
        <FirstRead workspace={workspace} />
      </Suspense>
    </>
  );
}

/** The first page as the api answers it, or the digest of a read it refused. */
async function FirstRead({ workspace }: { workspace: string }) {
  const params = { path: { workspaceId: workspace }, query: { limit: PAGE_SIZE } };
  try {
    const api = await serverApi();
    const first = await data(api.GET("/v1/workspaces/{workspaceId}/inbox/threads", { params }));
    return <Threads workspace={workspace} first={first} />;
  } catch (error) {
    if (error instanceof ApiError) return <Threads workspace={workspace} failed={error.digest} />;
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
