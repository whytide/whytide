// The e2e api's route for the ICP screen's audiences (core/apps/web/tests/icp-screen.spec.ts), test
// only: POST /test/icp/audiences/reset deletes every audience of AUDIENCES_WORKSPACE but its
// default, their criteria with them, so that a run of the spec starts under the workspace's limit
// whatever an earlier run left. The workspace is this file's, never the request's.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDbClient, type PrismaClient } from "@whytide/db";

/** The audiences' own workspace, the e2e users': no other spec writes its audiences. */
export const AUDIENCES_WORKSPACE = "wsp_e2e_audiences";

/** The handler of POST /test/icp/audiences/reset, which the e2e api mounts ahead of the routes. */
export function resetAudiencesRoute() {
  let db: PrismaClient | undefined;
  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    if (req.method !== "POST" || req.url !== "/test/icp/audiences/reset") return next();
    db ??= createDbClient("app");
    db.icp
      .deleteMany({ where: { workspaceId: AUDIENCES_WORKSPACE, isDefault: false } })
      .then(() => res.writeHead(204).end())
      .catch(next);
  };
}
