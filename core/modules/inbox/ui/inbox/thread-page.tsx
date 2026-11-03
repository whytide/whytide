// A thread of the inbox (README.md "Screen"), a server component that ui/thread/page.tsx mounts at
// /w/{workspace}/inbox/{threadId}: the <title>, then the thread's read, GET …/inbox/threads/{id} as
// the member, while the loading state shows the way back and cards that shimmer where the messages
// will come. thread.tsx holds the rest in the browser. A thread of another workspace, or none, is the
// page's not-found state; a read the api refuses otherwise is the thread's error state, with Try
// again; any other fault is the route's.
import { EmptyState, LoadingState, PageHeader, Skeleton } from "@whytide/ui";
import { ApiError, data, serverApi } from "@whytide/web/api/server";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { LOADING_LINES } from "./constants.ts";
import { BackLink, Thread } from "./thread.tsx";

type Props = { params: Promise<{ workspace: string; threadId: string }> };

export default async function ThreadPage({ params }: Props) {
  const { workspace, threadId } = await params;
  const t = await getTranslations("inbox.thread");
  return (
    <>
      <title>{t("title")}</title>
      <Suspense fallback={<Loading workspace={workspace} />}>
        <FirstRead workspace={workspace} threadId={threadId} />
      </Suspense>
    </>
  );
}

/** The thread as the api answers it, the not-found state, or the digest of a read it refused. */
async function FirstRead({ workspace, threadId }: { workspace: string; threadId: string }) {
  const params = { path: { workspaceId: workspace, id: threadId } };
  try {
    const api = await serverApi();
    const read = await api.GET("/v1/workspaces/{workspaceId}/inbox/threads/{id}", { params });
    if (read.response.status === 404) return <NotFound workspace={workspace} />;
    const first = await data(Promise.resolve(read));
    return <Thread workspace={workspace} threadId={threadId} first={first} />;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return <Thread workspace={workspace} threadId={threadId} failed={error.digest} />;
  }
}

/** The way back, the wait announced, and a message's card per group of lines. */
function Loading({ workspace }: { workspace: string }) {
  return (
    <>
      <BackLink workspace={workspace} />
      <section aria-busy="true" className="grid max-w-3xl gap-3">
        <LoadingState />
        <div aria-hidden="true" className="grid gap-3">
          {LOADING_LINES.map((lines, card) => (
            <div key={card} className="rounded-xl border border-line bg-surface p-5 shadow-xs">
              <Skeleton lines={lines} />
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

/** Another workspace's thread, or none: a heading, why, and the way back. */
function NotFound({ workspace }: { workspace: string }) {
  const t = useTranslations("inbox.thread");
  const errors = useTranslations("inbox.errors");
  return (
    <>
      <BackLink workspace={workspace} />
      <PageHeader title={t("not_found")} />
      <EmptyState message={errors("thread_not_found")} />
    </>
  );
}
