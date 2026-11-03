// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8): the
// organization and the workspace identity's first `pnpm invite` creates with bootstrapOrganization,
// and where the web header's feedback link goes, which GET /v1/me answers (alpha-p10-040).
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import { name, slug } from "./domain/rules.ts";

export const settings = defineConfig("modules/tenancy", {
  ORGANIZATION_NAME: name.default("My organization"),
  WORKSPACE_SLUG: slug.default("main"),
  // https only: every page links to it, so never javascript:, data: or plain http.
  FEEDBACK_URL: z.url({ protocol: /^https$/, normalize: true, error: "an https URL" }).optional(),
});
