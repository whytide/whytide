// The test module's panel in the evidence slot of contacts' lead page (ui/nav.ts `panels`), a server
// component as a module writes one: core/apps/web/tests/lead-page.spec.ts finds it in its place.
import { getTranslations } from "next-intl/server";

export default async function Evidence({ personId }: { workspace: string; personId: string }) {
  const t = await getTranslations("fixture.evidence");
  return <p>{t("body", { personId })}</p>;
}
