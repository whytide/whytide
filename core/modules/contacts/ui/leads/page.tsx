// The lead list (README "Screens"): the workspace's qualified leads by descending fit, twenty a
// page, or the view the URL names (query.ts: the list's own address, the lead page's way back), and
// how many leads are in each status, read as the member while the loading state shows; list.tsx
// filters, sorts and pages from the browser. React puts the <title> in the document's head: the
// generated route re-exports the page alone, so a `metadata` export would not reach Next.js.
import { PageHeader } from "@whytide/ui";
import { data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { LeadList } from "./list.tsx";
import { filtersOf, type View, viewOf } from "./query.ts";
import { LeadsLoading } from "./skeleton.tsx";

type Props = {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const LIMIT = 20;

export default async function Leads({ params, searchParams }: Props) {
  const { workspace } = await params;
  const start = viewOf(await searchParams);
  const t = await getTranslations("contacts.leads");
  return (
    <>
      <title>{t("title")}</title>
      <Suspense
        fallback={
          <>
            <PageHeader title={t("title")} description={t("description")} />
            <LeadsLoading />
          </>
        }
      >
        <FirstPage workspace={workspace} start={start} />
      </Suspense>
    </>
  );
}

/** The counts and the view's first page, read together. */
async function FirstPage({ workspace, start }: { workspace: string; start: View }) {
  const api = await serverApi();
  const path = { workspaceId: workspace };
  const query = { status: start.status, sort: start.sort, ...filtersOf(start), limit: LIMIT };
  const [{ counts }, first] = await Promise.all([
    data(api.GET("/v1/workspaces/{workspaceId}/contacts/leads/counts", { params: { path } })),
    data(api.GET("/v1/workspaces/{workspaceId}/contacts/leads", { params: { path, query } })),
  ]);
  return (
    <LeadList workspace={workspace} counts={counts} start={start} first={first} limit={LIMIT} />
  );
}
