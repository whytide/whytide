// The `balance` slot of the shell's header (ui/nav.ts): what the workspace's organization has left,
// GET …/credits/balance read as the member when the page loads; balance.tsx reads it again at each
// navigation, since the shell's layout stays while the pages change. A failed read shows nothing:
// the header never takes the page down, and the api has logged the failure.
import { serverApi } from "@whytide/web/api/server";
import { Balance } from "./balance.tsx";

export default async function BalanceSlot({ workspaceId }: { workspaceId: string }) {
  const request = { params: { path: { workspaceId } } };
  const { data } = await (await serverApi()).GET(
    "/v1/workspaces/{workspaceId}/credits/balance",
    request,
  );
  return <Balance workspaceId={workspaceId} initial={data?.available} />;
}
