// "Inbox" (README.md "Screen"), a server component: the <title> and the header, which says that only
// the conversations the platform started appear and that the tester answers on LinkedIn, and that the
// list holds the replies to the member's own senders (gamma-p6-060); then the list's first read,
// GET …/inbox/threads as the member, with linkedin's GET …/accounts, whether the member has a
// connected account of their own, for the empty state, while the loading state shows, rows that
// shimmer where the threads will come. threads.tsx holds the rest in the browser: the table, "Load
// more" and the reads after the first. A read of the threads the api refuses is the list's error
// state, with Try again; a refused read of the accounts leaves the plain empty state; any other fault
// is the route's. React puts the <title> in the document's head: the generated route re-exports the
// page alone, so a `metadata` export would not reach it.
import { LoadingState, PageHeader, Skeleton } from "@whytide/ui";
import { ApiError, data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { ACCOUNTS_PATH, LOADING_ROWS, PAGE_SIZE } from "./constants.ts";
import { Threads } from "./threads.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function Inbox({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("inbox.list");
  return (
    <>
      <title>{t("title")}</title>
      <PageHeader
        title={t("title")}
        description={t("description")}
        meta={<p className="text-sm text-ink-muted">{t("scope")}</p>}
      />
      <Suspense fallback={<Loading />}>
        <FirstRead workspace={workspace} />
      </Suspense>
    </>
  );
}

/**
 * The first page as the api answers it, or the digest of a read it refused; and whether the member
 * has a connected account of their own (linkedin's `mine`), so the empty state says to connect one.
 */
async function FirstRead({ workspace }: { workspace: string }) {
  const path = { workspaceId: workspace };
  const params = { path, query: { limit: PAGE_SIZE } };
  try {
    const api = await serverApi();
    // Beside the threads' read; failed, it is dropped: it only shapes the empty state.
    const accounts = api.GET(ACCOUNTS_PATH, { params: { path } }).catch(() => undefined);
    const first = await data(api.GET("/v1/workspaces/{workspaceId}/inbox/threads", { params }));
    const senders = (await accounts)?.data;
    // Unread, the member is taken to have one: the empty state then says only that none replied.
    const hasSender =
      senders?.accounts.some(({ mine, status }) => mine && status === "connected") ?? true;
    return <Threads workspace={workspace} first={first} hasSender={hasSender} />;
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
