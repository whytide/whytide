// "Up next" (README.md "Screen"), a server component: the <title>, then the queue's first read, GET
// …/approvals/items as the member, while the header and the loading state show, rows that shimmer
// where the steps will come. queue.tsx holds the rest in the browser: the header with its counters,
// the rows, their decisions and the reads after them. A read the api refuses is the queue's error
// state, with Try again; any other fault is the route's. React puts the <title> in the document's
// head: the generated route renders the page with its panels, so a `metadata` export would not
// reach it. The `disclosure` slot's panels, messaging's AI disclosure line (gamma-p4-090), are
// rendered here once per channel and given to the rows the campaign's mode will approve.

import { LoadingState, Skeleton } from "@whytide/ui";
import { ApiError, data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import type { ComponentType } from "react";
import { Suspense } from "react";
import { LOADING_LINES } from "./constants.ts";
import { Header } from "./header.tsx";
import type { Lines } from "./item.tsx";
import { Queue } from "./queue.tsx";
import type { PanelProps, UpNextSlot } from "./slots.ts";

type Props = {
  params: Promise<{ workspace: string }>;
  panels: Partial<Record<UpNextSlot, readonly ComponentType<PanelProps>[]>>;
};

export default async function UpNext({ params, panels }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("approvals.up_next");
  const own = panels.disclosure ?? [];
  const line = (channel: PanelProps["channel"]) =>
    own.map((Panel, index) => <Panel key={index} channel={channel} />);
  const lines: Lines = { linkedin: line("linkedin_message"), email: line("email") };
  return (
    <>
      <title>{t("title")}</title>
      <Suspense fallback={<Loading />}>
        <FirstRead workspace={workspace} lines={lines} />
      </Suspense>
    </>
  );
}

/** The queue as the api answers it, or the digest of a read it refused. */
async function FirstRead({ workspace, lines }: { workspace: string; lines: Lines }) {
  const params = { path: { workspaceId: workspace } };
  try {
    const api = await serverApi();
    const first = await data(api.GET("/v1/workspaces/{workspaceId}/approvals/items", { params }));
    return <Queue workspace={workspace} lines={lines} first={first} />;
  } catch (error) {
    if (error instanceof ApiError) {
      return <Queue workspace={workspace} lines={lines} failed={error.digest} />;
    }
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
