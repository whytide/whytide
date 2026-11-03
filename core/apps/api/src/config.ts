// The api's block of deploy/.env.example (README "Configuration"): the port it listens on, which
// `pnpm env:create` fills per worktree, and the URL it is reached at from outside.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

export const apiConfig = defineConfig("apps/api", {
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_PUBLIC_URL: z.url().optional(),
});
