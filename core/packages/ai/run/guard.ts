// What runs before Mastra loads (README.md "Mastra's guardrails"; decisions §14, rule 7). It is the
// first import of index.ts, run/run-agent.ts and mastra/instance.ts, the only file that imports
// Mastra: ESM evaluates imports in order, and Biome never moves an import across a side-effect one.
import { AppError } from "@whytide/platform";
import { aiErrors } from "../errors.ts";

// A key would turn on the Enterprise Edition code Mastra ships, which is not open source and checks
// the key with license.mastra.ai. Set counts, empty too: the value is never read or printed.
for (const variable of ["MASTRA_LICENSE_KEY", "MASTRA_EE_LICENSE"]) {
  if (process.env[variable] !== undefined) {
    throw new AppError(aiErrors.ai_mastra_license_set, { details: { variable } });
  }
}
// Off whatever was set: Mastra's telemetry (posthog) and its provider-list refresh (models.dev),
// which MASTRA_DEV starts; Mastra reads MASTRA_OFFLINE as on only when it is `true` or `1`.
process.env.MASTRA_TELEMETRY_DISABLED = "true";
process.env.MASTRA_OFFLINE = "true";
// Unset whatever was set (alpha-p1-135): `mastra dev` sets MASTRA_DEV, and with it Mastra refreshes
// its provider list and prices, and copies ~/.cache/mastra into its own dist/, offline too. Nothing
// here runs `mastra dev`: the playground is deferred (README "The playground").
delete process.env.MASTRA_DEV;

// A string model id goes to the AI SDK's default provider, the Vercel AI Gateway unless this global
// is set; `ai` 7 and the AI SDK copies inside Mastra read it. This one refuses every id and kind.
const refuse = (id: unknown): never => {
  throw new AppError(aiErrors.ai_model_id_refused, { details: { id: String(id) } });
};
const KINDS = [
  "languageModel",
  "embeddingModel",
  "textEmbeddingModel",
  "imageModel",
  "transcriptionModel",
  "speechModel",
  "rerankingModel",
  "videoModel",
  "speechTranslationModel",
  "decisionModel",
];
Object.assign(globalThis, {
  AI_SDK_DEFAULT_PROVIDER: Object.freeze({
    specificationVersion: "v4",
    ...Object.fromEntries(KINDS.map((kind) => [kind, refuse])),
  }),
});
