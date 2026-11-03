// credits' cost line in the cost slot of contacts' lead page (ui/nav.ts `panels`; README.md
// "Screens"), a server component: the lead's cost so far, read as the member, in one line. The slot
// shows the loading state while it reads, and a failed read as its error state with the code in words
// and a retry (contacts' slot-boundary.tsx).

import { Coins } from "@whytide/ui/icons";
import { data, serverApi } from "@whytide/web/api/server";
import { getFormatter, getTranslations } from "next-intl/server";
import { AMOUNT } from "../amount.ts";

export default async function LeadCost(props: { workspace: string; personId: string }) {
  const path = { workspaceId: props.workspace, personId: props.personId };
  const cost = await data(
    (await serverApi()).GET("/v1/workspaces/{workspaceId}/credits/leads/{personId}/cost", {
      params: { path },
    }),
  );
  const t = await getTranslations("credits.lead_cost");
  const format = await getFormatter();
  const amount = (value: string) => format.number(Number(value), AMOUNT);
  const line =
    cost.credits === "0" && cost.money === "0"
      ? t("none")
      : t("line", { credits: amount(cost.credits), money: amount(cost.money) });
  return (
    <p className="flex items-start gap-2 text-sm text-ink-muted">
      <Coins aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
      {line}
    </p>
  );
}
