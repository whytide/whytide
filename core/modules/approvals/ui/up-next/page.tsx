// "Up next" (README.md "Screen"), a server component: the <title>, then the queue's first read, GET
// …/approvals/items as the member, while the header and the loading state show, rows that shimmer
// where the steps will come. queue.tsx holds the rest in the browser: the header with its counters,
// the rows, their decisions and the reads after them. A read the api refuses is the queue's error
// state, with Try again; any other fault is the route's. React puts the <title> in the document's
// head: the generated route re-exports the page alone, so a `metadata` export would not reach it.
import { LoadingState, Skeleton } from "@whytide/ui";
import { ApiError, data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { LOADING_LINES } from "./constants.ts";
import { Header } from "./header.tsx";
import { Queue } from "./queue.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function UpNext({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("approvals.up_next");
  return (
    <>
      <title>{t("title")}</title>
      <Suspense fallback={<Loading />}>
        <FirstRead workspace={workspace} />
      </Suspense>
    </>
  );
}

/** The queue as the api answers it, or the digest of a read it refused. */
async function FirstRead({ workspace }: { workspace: string }) {
  const params = { path: { workspaceId: workspace } };
  try {
    const api = await serverApi();
    const first = await data(api.GET("/v1/workspaces/{workspaceId}/approvals/items", { params }));
    return <Queue workspace={workspace} first={first} />;
  } catch (error) {
    if (error instanceof ApiError) return <Queue workspace={workspace} failed={error.digest} />;
    throw error;
  }
}

/** The header without its counters, the wait announced, and a row's card per group of lines. */
function Loading() {
  return (
    <>
      <Header />
      <section aria-busy="true" className="grid gap-3">
        <LoadingState />
        <div aria-hidden="true" className="grid gap-3">
          {LOADING_LINES.map((lines, row) => (
            <div key={row} className="rounded-xl border border-line bg-surface p-5 shadow-xs">
              <Skeleton lines={lines} />
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
