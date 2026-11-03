// The web host's variables (deploy/.env.example, block apps/web), read by scripts/next.ts before it
// starts Next.js: WEB_PORT, the port `dev` and `start` listen on at 127.0.0.1; NEXT_PUBLIC_API_URL,
// the api's URL for the server's calls and the /api rewrite, http://127.0.0.1:API_PORT when empty.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

export const webConfig = defineConfig("apps/web", {
  WEB_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  NEXT_PUBLIC_API_URL: z.url().optional(),
});
