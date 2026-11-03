// The test module's screen, a server component as a module writes one: it greets `?name=` through the
// api's fixture route (core/apps/api/tests/fixtures/module), which answers `missing` with 404
// fixture_not_found, so the screen throws and the route's error.tsx shows the code in words. The
// greeting sits in a card, as a module's screen shows its content.
import { Card, PageHeader } from "@whytide/ui";
import { data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import type { Client } from "openapi-fetch";

type Props = {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
type Greeting = { name: string; greeting: string };
/** The api mounts the fixture route in its tests only, so the generated client has no type for it. */
type FixturePaths = {
  "/v1/workspaces/{workspaceId}/fixture/{name}": {
    get: {
      parameters: { path: { workspaceId: string; name: string } };
      responses: { 200: { content: { "application/json": Greeting } } };
    };
  };
};

export default async function Greeting({ params, searchParams }: Props) {
  const { workspace } = await params;
  const { name } = await searchParams;
  const t = await getTranslations("fixture.greeting");
  const api = (await serverApi()) as unknown as Client<FixturePaths>;
  const path = { workspaceId: workspace, name: typeof name === "string" ? name : "tester" };
  const answer = await data(
    api.GET("/v1/workspaces/{workspaceId}/fixture/{name}", { params: { path } }),
  );
  return (
    <>
      <PageHeader title={t("title")} />
      <Card>
        <p className="text-ink">{t("body", { greeting: answer.greeting, name: answer.name })}</p>
      </Card>
    </>
  );
}
