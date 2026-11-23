// The test module's panel in the draft slot of contacts' lead page and in the campaign slot of
// playbooks' agent page (ui/nav.ts `panels`), as the request's cookie `fixture_panel` asks: `throw`
// throws, as core/apps/web/tests/evidence-panel.spec.ts and playbooks-agents.spec.ts set it to prove
// each slot's error boundary; `wait`
// answers after two seconds with a line, so that contacts-states.spec.ts sees the slot's loading
// state and a retry's answer; `not_found` calls notFound(), which passes the slot's boundary; it
// renders nothing otherwise.
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

export default async function Failing() {
  const asked = (await cookies()).get("fixture_panel")?.value;
  if (asked === "throw") throw new Error("the fixture's panel throws, as the cookie asks");
  if (asked === "not_found") notFound();
  if (asked !== "wait") return null;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const t = await getTranslations("fixture.failing");
  return <p>{t("body")}</p>;
}
